/**
 * Telegram AI Bot - Cloudflare Worker + Upstash Redis (100% Safe & Stable)
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Bot is active.", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }

    const expectedSecret = env.WEBHOOK_SECRET_TOKEN;
    if (!expectedSecret) {
      console.error("Missing WEBHOOK_SECRET_TOKEN Worker secret");
      return new Response("Webhook not configured", { status: 503 });
    }
    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!constantTimeEqual(suppliedSecret, expectedSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (!update || typeof update !== "object") {
      return new Response("Bad Request", { status: 400 });
    }
    ctx.waitUntil(handleUpdate(update, env, ctx).catch(err => {
      console.error("Unhandled update error:", err?.stack || err);
    }));
    return new Response("OK", { status: 200 });
  }
};

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function isValidHttpsUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !u.username && !u.password;
  } catch { return false; }
}


// ==========================================
// ۰. توابع کمکی اتصال به دیتابیس Upstash Redis
// ==========================================
async function upstashCommand(env, cmd) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN) {
    console.error("Missing UPSTASH_URL or UPSTASH_TOKEN");
    return null;
  }
  try {
    const res = await fetch(env.UPSTASH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      console.error("Upstash HTTP error:", res.status);
      return null;
    }
    const data = await res.json();
    if (data?.error) {
      console.error("Upstash command error:", String(data.error).slice(0, 300));
      return null;
    }
    return data?.result ?? null;
  } catch (e) {
    console.error("Upstash Redis Error:", e?.message || e);
    return null;
  }
}

async function safeKvPut(env, key, value, options = {}) {
  try {
    const strVal = typeof value === 'string' ? value : JSON.stringify(value);
    const result = options.expirationTtl
      ? await upstashCommand(env, ["SET", key, strVal, "EX", Math.max(1, Math.floor(options.expirationTtl))])
      : await upstashCommand(env, ["SET", key, strVal]);
    return result === "OK";
  } catch (e) {
    console.error(`Upstash Set Error [${key}]:`, e);
    return false;
  }
}

async function safeKvGet(env, key) {
  try {
    const res = await upstashCommand(env, ["GET", key]);
    return res !== undefined && res !== null ? String(res) : null;
  } catch (e) {
    console.error(`Upstash Get Error [${key}]:`, e);
    return null;
  }
}

async function safeKvDelete(env, key) {
  try {
    const result = await upstashCommand(env, ["DEL", key]);
    return result !== null;
  } catch (e) {
    console.error(`Upstash Del Error [${key}]:`, e);
    return false;
  }
}

async function getBotInfo(botToken, env) {
  try {
    const cached = await safeKvGet(env, "BOT_INFO_CACHE");
    if (cached) { const parsed = parseJson(cached, null); if (parsed) return parsed; }
  } catch (e) {}

  const res = await tgRequest(botToken, "getMe", {});
  if (res.ok && res.result) {
    await safeKvPut(env, "BOT_INFO_CACHE", res.result, { expirationTtl: 86400 });
    return res.result;
  }
  return null;
}

async function isGroupAdmin(botToken, chatId, userId, envAdminId) {
  if (String(userId) === String(envAdminId)) return true;
  try {
    const res = await tgRequest(botToken, "getChatMember", {
      chat_id: chatId,
      user_id: userId
    });
    if (res.ok && res.result) {
      const status = res.result.status;
      return status === "creator" || status === "administrator";
    }
  } catch (e) {
    console.error("isGroupAdmin Error:", e);
  }
  return false;
}

// ==========================================
// ۱. هندلر اصلی پردازش آپدیت‌های تلگرام
// ==========================================
async function handleUpdate(update, env, ctx) {
  const botToken = env.BOT_TOKEN;
  const adminId = String(env.ADMIN_ID || "");
  if (!botToken || !update || typeof update !== "object") {
    console.error("Missing BOT_TOKEN or invalid update");
    return;
  }

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;

    if (!msg.from) return;

    const userId = String(msg.from.id);
    let text = msg.text || msg.caption || "";
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    ctx.waitUntil(trackUserActivity(env, userId));

    if (msg.document) {
      const doc = msg.document;
      if (doc.file_name && (doc.file_name.endsWith('.js') || doc.file_name.endsWith('.py') || doc.file_name.endsWith('.txt') || doc.file_name.endsWith('.json') || doc.file_name.endsWith('.html') || doc.file_name.endsWith('.css') || doc.file_name.endsWith('.cpp') || doc.file_name.endsWith('.java'))) {
        const fileContent = await getTelegramFileText(botToken, doc.file_id);
        if (fileContent) {
          text = `${text}\n\n محتوای فایل ارسال شده (${doc.file_name}):\n\`\`\`\n${fileContent}\n\`\`\``;
        }
      }
    }

    const isBanned = await safeKvGet(env, `BANNED_${userId}`);
    if (isBanned === "true") {
      await tgRequest(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⛔ حساب شما توسط مدیریت مسدود شده است."
      });
      return;
    }

    if (!isGroup) {
      const sponsorCheck = await checkSponsorJoin(botToken, env, userId);
      if (!sponsorCheck.ok && adminId && userId !== adminId) {
        const keyboard = [];
        let currentRow = [];
        sponsorCheck.unjoined.forEach(ch => {
          currentRow.push({ text: `📢 ورود به کانال ${ch}`, url: `https://t.me/${ch.replace("@", "")}` });
          if (currentRow.length === 2) {
            keyboard.push(currentRow);
            currentRow = [];
          }
        });
        if (currentRow.length > 0) keyboard.push(currentRow);
        keyboard.push([{ text: "✅ عضو شدم / بررسی", callback_data: "check_sponsor" }]);

        await tgRequest(botToken, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ برای استفاده از ربات ابتدا باید در کانال(های) اسپانسر زیر عضو شوید:",
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }

      const adminStep = await safeKvGet(env, `ADMIN_STEP_${userId}`);
      if (adminStep && userId === adminId) {
        await handleAdminSteps(botToken, env, chatId, userId, text, adminStep);
        return;
      }
    }

    if (text.startsWith("/start")) {
      if (isGroup) {
        const isAdmin = await isGroupAdmin(botToken, chatId, userId, adminId);
        if (!isAdmin) {
          return;
        }

        const botInfo = await getBotInfo(botToken, env);
        const botUsername = botInfo?.username || "freeContentAI_bot";
        await tgRequest(botToken, "sendMessage", {
          chat_id: chatId,
          text: "⚠️ **منوی تنظیمات و مدیریت ربات فقط در چت خصوصی (پیوی) قابل استفاده است.**\n\nجهت استفاده از امکانات ربات روی دکمه زیر کلیک کنید:",
          parse_mode: "Markdown",
          reply_to_message_id: msg.message_id,
          allow_sending_without_reply: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: "🤖 ورود به پیوی ربات", url: `https://t.me/${botUsername}?start=true` }]
            ]
          }
        });
        return;
      }
      await clearUserState(env, userId);
      await sendMainMenu(botToken, chatId, userId, adminId);
      return;
    }

    if (text.startsWith("/models")) {
      if (isGroup) {
        const isAdmin = await isGroupAdmin(botToken, chatId, userId, adminId);
        if (!isAdmin) {
          await tgRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: "⛔ تغییر مدل ربات در گروه فقط توسط ادمین‌های گروه مجاز است.",
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
          });
          return;
        }
      } else if (adminId && userId !== adminId) {
        await tgRequest(botToken, "sendMessage", {
          chat_id: chatId,
          text: "⛔ این دستور تنها برای ادمین ربات مجاز است."
        });
        return;
      }
      await sendModelSelectionMenu(botToken, env, chatId, isGroup ? `group_${chatId}` : userId);
      return;
    }

    // پردازش اختصاصی گروه‌ها
    let targetReplyMsgId = msg.message_id;

    if (isGroup) {
      const botInfo = await getBotInfo(botToken, env);
      const rawUsername = botInfo?.username || "freeContentAI_bot";
      const botUsername = `@${rawUsername.toLowerCase()}`;
      const botUsernamePlain = rawUsername.toLowerCase();
      const botId = botInfo?.id;

      const lowerText = text.toLowerCase().trim();

      // بررسی دقیق دستورات مدیریتی /bot (فقط برای ادمین و کاملاً بی‌صدا برای کاربران عادی)[cite: 6]
      const isExactAdminCmd = lowerText === "/bot" || lowerText === "bot" || 
                              lowerText.startsWith("/bot test") || lowerText.startsWith("bot test") ||
                              lowerText.startsWith("/bot سکوت") || lowerText.startsWith("bot سکوت") ||
                              lowerText.startsWith("/bot صحبت") || lowerText.startsWith("bot صحبت") ||
                              lowerText.startsWith("/bot راهنما") || lowerText.startsWith("bot راهنما");

      if (isExactAdminCmd) {
        const isAdmin = await isGroupAdmin(botToken, chatId, userId, adminId);
        if (!isAdmin) {
          return; // اگر کاربر عادی است، هیچ واکنشی نشان ندهد[cite: 6]
        }

        if (lowerText.includes("سکوت")) {
          await safeKvPut(env, `GROUP_MUTED_${chatId}`, "true");
          await tgRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: "🔇 **وضعیت ربات:** متوقف و در حالت سکوت قرار گرفت.",
            parse_mode: "Markdown",
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
          });
          return;
        } else if (lowerText.includes("صحبت")) {
          await safeKvPut(env, `GROUP_MUTED_${chatId}`, "false");
          await tgRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: "🔊 **وضعیت ربات:** فعال و آماده پاسخگویی شد.",
            parse_mode: "Markdown",
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
          });
          return;
        } else if (lowerText.includes("test")) {
          await tgRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: "✅ **وضعیت ربات:** آنلاین، پایدار و متصل به هوش مصنوعی!",
            parse_mode: "Markdown",
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
          });
          return;
        } else {
          const helpText = 
            `🛠 **پنل راهنمای مدیریت ربات در گروه**\n\n` +
            `🟢 وضعیت: \`سیستم فعال و آماده به کار\`\n\n` +
            `📌 **دستورات مدیریتی ویژه ادمین:**\n` +
            `🔹 \`/bot test\` ➔ بررسی وضعیت آنلاین بودن ربات\n` +
            `🔹 \`/bot سکوت\` ➔ متوقف کردن موقت پاسخگویی ربات\n` +
            `🔹 \`/bot صحبت\` ➔ فعال‌سازی مجدد ربات در گروه\n\n` +
            `💡 *نکته:* این دستورات صرفاً توسط ادمین‌ها قابل اجرا هستند.`;

          await tgRequest(botToken, "sendMessage", {
            chat_id: chatId,
            text: helpText,
            parse_mode: "Markdown",
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
          });
          return;
        }
      }

      // بررسی حالت سکوت گروه[cite: 6]
      const isGroupMuted = await safeKvGet(env, `GROUP_MUTED_${chatId}`);
      if (isGroupMuted === "true") {
        return;
      }

      const isReplyToBot = msg.reply_to_message && String(msg.reply_to_message.from?.id) === String(botId);
      const isReplyToUser = msg.reply_to_message && String(msg.reply_to_message.from?.id) !== String(botId);

      let isMentioned = false;
      
      // ۱. بررسی منشن‌های Entities تلگرام (با پشتیبانی کامل از mention و text_mention)[cite: 6]
      const entities = msg.entities || msg.caption_entities || [];
      for (const ent of entities) {
        if (ent.type === "mention") {
          const mentionText = text.substring(ent.offset, ent.offset + ent.length).toLowerCase();
          if (mentionText === botUsername || mentionText === "@freeContentAI_bot") isMentioned = true;
        } else if (ent.type === "text_mention" && botInfo?.id && String(ent.user?.id) === String(botInfo.id)) {
          isMentioned = true;
        }
      }

      // ۲. بررسی متنی آیدی ربات (پشتیبانی از نوشتن آیدی در متن پیام مانند @freeContentAI_bot)[cite: 6]
      if (lowerText.includes(botUsername) || lowerText.includes(`@${botUsernamePlain}`) || lowerText.includes("@freeContentAI_bot")) {
        isMentioned = true;
      }

      // ۳. کلیدواژه‌ها و پیشوندهای صدا زدن ربات[cite: 6]
      const callPrefixes = ["bot", "ai", "ربات", "پاسخ"];
      const startsWithCallPrefix = callPrefixes.some(p => lowerText === p || lowerText.startsWith(p + " ") || lowerText.startsWith(p + "\n"));

      // اگر هیچ‌کدام از شرایط صدا زدن برقرار نبود، پیام نادیده گرفته می‌شود[cite: 6]
      if (!isReplyToBot && !isMentioned && !startsWithCallPrefix) {
        return;
      }

      // پاک‌سازی نام ربات یا پیشوند از متن اصلی برای ارسال پرامپت تمیز به هوش مصنوعی[cite: 6]
      if (botUsername) {
        const escapedUsername = botUsername.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        text = text.replace(new RegExp(escapedUsername, 'gi'), "").trim();
      }
      if (botUsernamePlain) {
        text = text.replace(new RegExp(`@${botUsernamePlain}`, 'gi'), "").trim();
      }
      text = text.replace(/@freeContentAI_bot/gi, "").trim();

      for (const p of callPrefixes) {
        if (lowerText === p || lowerText.startsWith(p + " ") || lowerText.startsWith(p + "\n")) {
          const regex = new RegExp(`^${p}(\\s+|\n)?`, 'i');
          text = text.replace(regex, "").trim();
          break;
        }
      }

      // پاسخ هوشمند به پیام ریپلای‌شده کاربر دیگر[cite: 6]
      if (msg.reply_to_message && msg.reply_to_message.from) {
        const targetUser = msg.reply_to_message.from;
        const targetUserId = String(targetUser.id);
        const targetName = targetUser.first_name || "کاربر";

        if (String(targetUserId) !== String(botId)) {
          targetReplyMsgId = msg.reply_to_message.message_id;

          if (msg.reply_to_message.photo && msg.reply_to_message.photo.length > 0 && (!msg.photo || msg.photo.length === 0)) {
            msg.photo = msg.reply_to_message.photo;
          }

          let repliedText = msg.reply_to_message.text || msg.reply_to_message.caption || "";

          if (msg.reply_to_message.document) {
            const doc = msg.reply_to_message.document;
            if (doc.file_name && (doc.file_name.endsWith('.js') || doc.file_name.endsWith('.py') || doc.file_name.endsWith('.txt') || doc.file_name.endsWith('.json') || doc.file_name.endsWith('.html') || doc.file_name.endsWith('.css') || doc.file_name.endsWith('.cpp') || doc.file_name.endsWith('.java'))) {
              const fileContent = await getTelegramFileText(botToken, doc.file_id);
              if (fileContent) {
                repliedText = `${repliedText}\n\nمحتوای فایل ضمیمه‌شده (${doc.file_name}):\n\`\`\`\n${fileContent}\n\`\`\``;
              }
            }
          }

          const promptInstruction = text.trim() ? text.trim() : "لطفاً بررسی کن و پاسخ کامل بده.";
          text = `[پیام اصلی کاربر (${targetName}): "${repliedText || "تصویر/فایل بدون متن"}" ]\n\nدستور/سوال درباره این پیام:\n${promptInstruction}`;
        }
      }
    }

    const targetKeyId = isGroup ? `group_${chatId}` : userId;
    const userMode = (await safeKvGet(env, `USER_MODE_${targetKeyId}`)) || "CHAT";

    if (userMode === "IMAGE_GEN") {
      await processImageRequest(botToken, env, chatId, userId, text, targetKeyId);
    } else {
      await processAIRequest(botToken, env, chatId, userId, msg, text, targetKeyId, isGroup, targetReplyMsgId);
    }

  } else if (update.callback_query) {
    const query = update.callback_query;
    if (!query?.id || !query.from?.id || !query.message?.chat?.id || typeof query.data !== "string") {
      if (query?.id) await tgRequest(botToken, "answerCallbackQuery", { callback_query_id: query.id, text: "درخواست نامعتبر است." });
      return;
    }
    const chatId = query.message.chat.id;
    const userId = String(query.from.id);
    const data = query.data;
    const isGroupQuery = query.message.chat.type === "group" || query.message.chat.type === "supergroup";
    const targetKeyId = isGroupQuery ? `group_${chatId}` : userId;
    const adminId = String(env.ADMIN_ID || "");

    if (data.startsWith("cancel_req_")) {
      const reqId = data.replace("cancel_req_", "");
      const ownerUserId = reqId.split("_")[0];

      if (userId !== ownerUserId) {
        await tgRequest(botToken, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: "⛔ این درخواست متعلق به شما نیست!",
          show_alert: true
        });
        return;
      }

      const cancelStored = await safeKvPut(env, `CANCEL_${reqId}`, "true", { expirationTtl: 300 });
      await tgRequest(botToken, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: cancelStored ? "✅ درخواست لغو شد." : "⚠️ ثبت لغو ناموفق بود؛ دوباره تلاش کنید.",
        show_alert: !cancelStored
      });
      if (!cancelStored) return;
      await tgRequest(botToken, "editMessageText", { chat_id: chatId, message_id: query.message.message_id, text: "❌ درخواست توسط کاربر لغو شد." });
      return;
    }

    if (isGroupQuery) {
      const settingsButtons = ["mode_chat", "mode_image", "select_model_menu"];
      const isSetModel = data.startsWith("set_model_") || data.startsWith("set_img_model_");

      if (settingsButtons.includes(data) || isSetModel) {
        const isAdmin = await isGroupAdmin(botToken, chatId, userId, adminId);
        if (!isAdmin) {
          await tgRequest(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "⛔ تغییر تنظیمات و مدل ربات در گروه فقط توسط ادمین امکان‌پذیر است!",
            show_alert: true
          });
          return;
        }
      }

      const pvOnlyButtons = ["main_menu", "check_sponsor", "history_menu", "new_chat"];
      const isPvOnlyPrefix = data.startsWith("switch_sess_") || data.startsWith("admin_");

      if (pvOnlyButtons.includes(data) || isPvOnlyPrefix) {
        await tgRequest(botToken, "answerCallbackQuery", {
          callback_query_id: query.id,
          text: "⚠️ این منو فقط در چت خصوصی (پیوی) ربات قابل استفاده است.",
          show_alert: true
        });
        return;
      }
    }

    await tgRequest(botToken, "answerCallbackQuery", { callback_query_id: query.id });

    if (data === "check_sponsor" || data === "main_menu" || data === "mode_chat" || data === "mode_image" || data === "select_model_menu" || data === "history_menu" || data === "new_chat") {
      await clearUserState(env, userId);
    }

    if (data === "check_sponsor" || data === "main_menu") {
      if (!isGroupQuery) await sendMainMenu(botToken, chatId, userId, adminId);
    } else if (data === "mode_chat") {
      await safeKvPut(env, `USER_MODE_${targetKeyId}`, "CHAT");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "💬 حالت گفتگو متنی، تصویری، فایل و ساخت کد فعال شد." });
    } else if (data === "mode_image") {
      await safeKvPut(env, `USER_MODE_${targetKeyId}`, "IMAGE_GEN");
      if (!isGroupQuery) await sendImageModelSelectionMenu(botToken, env, chatId, userId);
    } else if (data === "select_model_menu") {
      await sendModelSelectionMenu(botToken, env, chatId, targetKeyId);
    } else if (data.startsWith("set_model_")) {
      const modelIndex = data.replace("set_model_", "");
      await safeKvPut(env, `USER_MODEL_${targetKeyId}`, modelIndex);
      
      const activeSessId = await safeKvGet(env, `ACTIVE_SESSION_${userId}`);
      if (activeSessId) {
        let sessions = parseJson(await safeKvGet(env, `SESSIONS_${userId}`), []);
        const sess = sessions.find(s => s.id === activeSessId);
        if (sess) {
          sess.modelIndex = modelIndex;
          await safeKvPut(env, `SESSIONS_${userId}`, JSON.stringify(sessions));
        }
      }

      const models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
      const selectedModelName = models[modelIndex]?.name || "انتخاب شده";
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `✅ مدل فعال چت روی **${selectedModelName}** تنظیم شد.` });
    } else if (data.startsWith("set_img_model_")) {
      const imgIdx = data.replace("set_img_model_", "");
      await safeKvPut(env, `USER_IMG_MODEL_${targetKeyId}`, imgIdx);
      const imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
      const selectedImgName = imgModels[imgIdx]?.name || "انتخاب شده";
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `🎨 مدل ساخت عکس روی **${selectedImgName}** تنظیم شد.` });
    } else if (data === "history_menu" && !isGroupQuery) {
      await sendHistoryMenu(botToken, env, chatId, userId);
    } else if (data === "new_chat" && !isGroupQuery) {
      const newSessId = `sess_${Date.now()}`;
      await safeKvPut(env, `ACTIVE_SESSION_${userId}`, newSessId);
      let sessions = parseJson(await safeKvGet(env, `SESSIONS_${userId}`), []);
      sessions.unshift({ id: newSessId, title: "گفتگوی جدید 💬", date: new Date().toLocaleDateString('fa-IR') });
      await safeKvPut(env, `SESSIONS_${userId}`, JSON.stringify(sessions));
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "✨ چت جدید ایجاد شد! پیام خود را بفرستید." });
    } else if (data.startsWith("switch_sess_") && !isGroupQuery) {
      const sessId = data.replace("switch_sess_", "");
      await safeKvPut(env, `ACTIVE_SESSION_${userId}`, sessId);
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔄 با موفقیت به این گفتگو منتقل شدید." });
    } else if (data === "admin_panel" && userId === adminId) {
      await clearUserState(env, userId);
      await sendAdminPanel(botToken, chatId);
    } else if (data === "admin_stats" && userId === adminId) {
      await sendBotStats(botToken, env, chatId);
    } else if (data === "admin_add_model" && userId === adminId) {
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_MODEL_NAME");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📝 نام عمومی مدل چت را وارد کنید:" });
    } else if (data === "admin_add_img_model" && userId === adminId) {
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_IMG_NAME");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🎨 نام عمومی مدل ساخت عکس را وارد کنید:" });
    } else if (data === "admin_list_models" && userId === adminId) {
      await sendAdminModelsList(botToken, env, chatId);
    } else if (data === "admin_edit_models_menu" && userId === adminId) {
      await sendAdminEditModelsList(botToken, env, chatId);
    } else if (data.startsWith("edit_model_") && userId === adminId) {
      const idx = data.replace("edit_model_", "");
      await safeKvPut(env, `ADMIN_EDIT_IDX_${userId}`, idx);
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_MODEL_NAME");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "✏️ نام جدید مدل چت را وارد کنید (یا .):" });
    } else if (data.startsWith("edit_img_model_") && userId === adminId) {
      const idx = Number(data.replace("edit_img_model_", ""));
      const models = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
      if (!Number.isInteger(idx) || idx < 0 || idx >= models.length) {
        await tgRequest(botToken, "answerCallbackQuery", { callback_query_id: query.id, text: "مدل پیدا نشد؛ فهرست را تازه کنید.", show_alert: true });
        return;
      }
      await safeKvPut(env, `ADMIN_EDIT_IMG_IDX_${userId}`, String(idx));
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_IMG_NAME");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "✏️ نام جدید مدل تصویر را وارد کنید (یا . برای حفظ مقدار):" });
    } else if (data.startsWith("del_model_") && userId === adminId) {
      const idx = parseInt(data.replace("del_model_", ""));
      let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
      if (idx >= 0 && idx < models.length) {
        models.splice(idx, 1);
        await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
      }
      await sendAdminModelsList(botToken, env, chatId, query.message.message_id);
    } else if (data.startsWith("del_img_model_") && userId === adminId) {
      const idx = parseInt(data.replace("del_img_model_", ""));
      let imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
      if (idx >= 0 && idx < imgModels.length) {
        imgModels.splice(idx, 1);
        await safeKvPut(env, "IMAGE_MODELS", JSON.stringify(imgModels));
      }
      await sendAdminModelsList(botToken, env, chatId, query.message.message_id);
    } else if (data === "admin_add_sponsor" && userId === adminId) {
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_SPONSOR");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📢 آیدی کانال اسپانسری را وارد کنید:" });
    } else if (data === "admin_del_sponsor_menu" && userId === adminId) {
      await sendAdminSponsorList(botToken, env, chatId);
    } else if (data.startsWith("del_sponsor_") && userId === adminId) {
      const idx = Number(data.replace("del_sponsor_", ""));
      let channels = parseJson(await safeKvGet(env, "SPONSOR_CHANNELS"), []);
      if (Number.isInteger(idx) && idx >= 0 && idx < channels.length) channels.splice(idx, 1);
      await safeKvPut(env, "SPONSOR_CHANNELS", JSON.stringify(channels));
      await sendAdminSponsorList(botToken, env, chatId, query.message.message_id);
    } else if (data === "admin_ban_user" && userId === adminId) {
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "BAN_USER");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🚫 آیدی عددی کاربر برای مسدودسازی:" });
    } else if (data === "admin_unban_user" && userId === adminId) {
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "UNBAN_USER");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "✅ آیدی عددی کاربر برای رفع مسدودی:" });
    }
  }
}

// ==========================================
// ۲. منوها و رابط کاربری (چینش دو تایی دکمه‌ها در هر سطر)
// ==========================================
async function sendMainMenu(botToken, chatId, userId, adminId) {
  const keyboard = [
    [
      { text: "💬 گفتگو و کدنویسی", callback_data: "mode_chat" },
      { text: "🎨 تصویرسازی هوش مصنوعی", callback_data: "mode_image" }
    ],
    [
      { text: "🤖 انتخاب مدل هوش مصنوعی", callback_data: "select_model_menu" },
      { text: "📜 تاریخچه گفتگوها", callback_data: "history_menu" }
    ],
    [
      { text: "➕ شروع گفتگوی جدید", callback_data: "new_chat" }
    ]
  ];

  if (userId === adminId) {
    keyboard[keyboard.length - 1].push({ text: "⚙️ پنل مدیریت ادمین", callback_data: "admin_panel" });
  }

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: "🚀سلام دوست خوبم به ربات هوش مصنوعی خودت خوش امدی از منو پایین گزینه مورد نظرت رو انتخاب کن 🫡!",
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendHistoryMenu(botToken, env, chatId, userId) {
  const sessions = parseJson(await safeKvGet(env, `SESSIONS_${userId}`), []);
  const activeSess = await safeKvGet(env, `ACTIVE_SESSION_${userId}`);

  if (sessions.length === 0) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📜 هیچ تاریخچه گفتگویی یافت نشد." });
    return;
  }

  let keyboard = [];
  let currentRow = [];
  sessions.slice(0, 10).forEach((s) => {
    const isCurrent = s.id === activeSess ? "🟢 " : "💬 ";
    const chatDate = s.date || new Date().toLocaleDateString('fa-IR');
    currentRow.push({ text: `${isCurrent}${s.title} 📅 [${chatDate}]`, callback_data: `switch_sess_${s.id}` });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }

  keyboard.push([
    { text: "➕ ایجاد چت جدید", callback_data: "new_chat" },
    { text: "🔙 بازگشت به منوی اصلی", callback_data: "main_menu" }
  ]);

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: "📜 **لیست گفتگوهای قبلی شما:**",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendModelSelectionMenu(botToken, env, chatId, targetKeyId) {
  const models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
  const currentModelIdx = (await safeKvGet(env, `USER_MODEL_${targetKeyId}`)) || "0";

  if (models.length === 0) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "⚠️ هیچ مدلی تعریف نشده است." });
    return;
  }

  let keyboard = [];
  let currentRow = [];
  models.forEach((m, index) => {
    currentRow.push({
      text: `${String(index) === String(currentModelIdx) ? "✅ " : "🤖 "}${m.name} ${m.supportsVision ? "👁️" : ""}`,
      callback_data: `set_model_${index}`
    });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }
  
  keyboard.push([{ text: "🔙 بازگشت به منوی اصلی", callback_data: "main_menu" }]);

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: "✨ **مدل هوش مصنوعی چت را انتخاب کنید:**",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendImageModelSelectionMenu(botToken, env, chatId, userId) {
  const imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
  const currentIdx = (await safeKvGet(env, `USER_IMG_MODEL_${userId}`)) || "0";

  if (imgModels.length === 0) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "⚠️ هیچ مدل تصویرسازی تعریف نشده است." });
    return;
  }

  let keyboard = [];
  let currentRow = [];
  imgModels.forEach((m, index) => {
    currentRow.push({
      text: `${String(index) === String(currentIdx) ? "✅ " : "🎨 "}${m.name}`,
      callback_data: `set_img_model_${index}`
    });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }
  keyboard.push([{ text: "🔙 بازگشت به منوی اصلی", callback_data: "main_menu" }]);

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: "🎨 **مدل ساخت عکس را انتخاب کنید:**",
    reply_markup: { inline_keyboard: keyboard }
  });
}

function isCodeRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const codeKeywords = [
    'code', 'script', 'bug', 'error', 'function', 'const', 'let', 'var', 
    'import', 'export', 'def', 'class', 'html', 'css', 'js', 'python', 
    'c++', 'java', 'sql', 'json', 'async', 'await', 'return', 'if', 'else',
    'کد', 'برنامه', 'اسکریپت', 'باگ', 'خطا', 'دیباگ', 'خط', 'توابع', 'متغیر', 'ارور', 'بساز', 'بنویس'
  ];
  return codeKeywords.some(keyword => lower.includes(keyword));
}

// ==========================================
// ۳. پردازش چت و ساخت کد با پایداری کامل
// ==========================================
async function processAIRequest(botToken, env, chatId, userId, msg, textPrompt, targetKeyId, isGroup, targetReplyMsgId = null) {
  const models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
  const activeSessionId = await getOrCreateActiveSession(env, userId);

  let userSelectedModel = await safeKvGet(env, `USER_MODEL_${targetKeyId}`);
  if (userSelectedModel === null) {
    userSelectedModel = await safeKvGet(env, `USER_MODEL_${userId}`);
  }

  let modelIdx = parseInt(userSelectedModel || "0");
  if (isNaN(modelIdx) || !models[modelIdx]) modelIdx = 0;

  if (models.length === 0 || !models[modelIdx]) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "⚠️ ابتدا یک مدل چت اضافه کنید." });
    return;
  }

  const activeModel = models[modelIdx];
  if (!textPrompt) textPrompt = "لطفاً بررسی کن یا پاسخ بده.";
  const isCode = isCodeRequest(textPrompt);

  const reqId = `${userId}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const cancelKeyboard = {
    inline_keyboard: [[{ text: "❌ لغو و توقف فکر کردن", callback_data: `cancel_req_${reqId}` }]]
  };

  const replyToUse = targetReplyMsgId || (isGroup ? msg.message_id : undefined);

  let statusMsgPayload = {
    chat_id: chatId,
    text: isCode ? "💻 در حال نوشتن و ساخت کد... (۵ ثانیه)" : "🧠 در حال فکر کردن... (۵ ثانیه)",
    reply_markup: cancelKeyboard
  };

  if (replyToUse) {
    statusMsgPayload.reply_to_message_id = replyToUse;
    statusMsgPayload.allow_sending_without_reply = true;
  }

  let statusRes = await tgRequest(botToken, "sendMessage", statusMsgPayload);

  if (!statusRes.ok || !statusRes.result?.message_id) {
    delete statusMsgPayload.reply_to_message_id;
    delete statusMsgPayload.allow_sending_without_reply;
    statusRes = await tgRequest(botToken, "sendMessage", statusMsgPayload);
  }

  const statusMsgId = statusRes.result?.message_id;
  if (!statusMsgId) return;

  let seconds = 5;
  let isDone = false;
  let apiResponseText = null;
  let wasCancelled = false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // قطع کنترل‌شده درخواست پس از ۲۵ ثانیه

  const timerPromise = (async () => {
    while (!isDone && seconds < 30) {
      await sleep(5000);
      if (isDone) break;

      const isCancelled = await safeKvGet(env, `CANCEL_${reqId}`);
      if (isCancelled === "true") {
        wasCancelled = true;
        isDone = true;
        controller.abort();
        break;
      }

      seconds += 5;
      await tgRequest(botToken, "sendChatAction", { chat_id: chatId, action: "typing" });

      if (seconds >= 25) {
        // The request AbortController owns the actual timeout; the timer only updates UX.
        break;
      }

      const currentStatusText = isCode
        ? `💻 در حال نوشتن، ساخت و دیباگ کد... (${seconds} ثانیه)`
        : `🧠 در حال فکر کردن... (${seconds} ثانیه)`;
      try {
        await tgRequest(botToken, "editMessageText", {
          chat_id: chatId,
          message_id: statusMsgId,
          text: currentStatusText,
          reply_markup: cancelKeyboard
        });
      } catch (e) {}
    }
  })();

  try {
    let history = parseJson(await safeKvGet(env, `HISTORY_${userId}_${activeSessionId}`), []);
    let userContent;

    if (msg.photo && msg.photo.length > 0) {
      if (!activeModel.supportsVision) {
        isDone = true;
        controller.abort();
        await tgRequest(botToken, "editMessageText", {
          chat_id: chatId,
          message_id: statusMsgId,
          text: "❌ این مدل از تحلیل عکس پشتیبانی نمی‌کند."
        });
        return;
      }
      const photo = msg.photo[msg.photo.length - 1];
      const fileBase64 = await getTelegramFileBase64(botToken, photo.file_id);
      if (!fileBase64) {
        isDone = true;
        controller.abort();
        await tgRequest(botToken, "editMessageText", {
          chat_id: chatId,
          message_id: statusMsgId,
          text: "❌ خطا در دریافت تصویر از تلگرام."
        });
        return;
      }
      userContent = [
        { type: "text", text: textPrompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fileBase64}` } }
      ];
    } else {
      userContent = textPrompt;
    }

    history.push({ role: "user", content: userContent });

    let cleanedMessages = history.map((item, idx) => {
      if (idx < history.length - 1 && Array.isArray(item.content)) {
        const textPart = item.content.find(p => p.type === "text")?.text || "تصویر قبلی";
        return { role: item.role, content: `[تصویر ارسال شده: ${textPart}]` };
      }
      return item;
    });

    while (cleanedMessages.length > 0 && cleanedMessages[0].role === "assistant") {
      cleanedMessages.shift();
    }

    if (cleanedMessages.length > 10) {
      cleanedMessages = cleanedMessages.slice(-10);
      if (cleanedMessages[0].role === "assistant") cleanedMessages.shift();
    }

    const baseUrl = String(activeModel.baseUrl || "").trim().replace(/\/+$/, "");
    if (!isValidHttpsUrl(baseUrl)) throw new Error("Invalid model API URL: HTTPS URL required");
    const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;

    const systemPrompt = {
      role: "system",
      content: "تو یک مهندس ارشد نرم‌افزار و متخصص هوش مصنوعی هستی. پاسخ کاربر را کاملاً دقیق، تمیز، خلاصه و به همراه توضیحات لازم یا کد Markdown ارسال کن."
    };

    const payload = {
      model: activeModel.modelName,
      messages: [systemPrompt, ...cleanedMessages],
      max_tokens: 1500,
      stream: false
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${activeModel.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const isCancelled = await safeKvGet(env, `CANCEL_${reqId}`);
    if (isCancelled === "true" || wasCancelled) {
      wasCancelled = true;
      apiResponseText = null;
    } else if (res.ok) {
      const data = await res.json();
      if (data.choices && data.choices[0] && data.choices[0].message) {
        apiResponseText = data.choices[0].message.content;
      }
    } else {
      const errDetail = await res.text();
      console.error("AI Error Status:", res.status, errDetail);
      apiResponseText = `❌ خطای پاسخ‌دهی از سمت سرویس API (کد خطا: ${res.status})`;
    }

    if (apiResponseText && !apiResponseText.startsWith("❌")) {
      history.push({ role: "assistant", content: apiResponseText });

      const historyToSave = history.slice(-12).map(item => {
        if (Array.isArray(item.content)) {
          const textPart = item.content.find(p => p.type === "text")?.text || "تصویر";
          return { role: item.role, content: textPart };
        }
        return item;
      });

      await safeKvPut(env, `HISTORY_${userId}_${activeSessionId}`, JSON.stringify(historyToSave));
      await updateSessionTitleIfNew(env, userId, activeSessionId, textPrompt);
    }
  } catch (err) {
    if (wasCancelled) {
      apiResponseText = null;
    } else if (err.name === 'AbortError') {
      apiResponseText = "❌ زمان پاسخ‌دهی به ۳۰ ثانیه نزدیک شد و ارتباط به دلیل محدودیت سرورهای لبه کلودفلر (Cloudflare Workers) قطع شد. لطفاً درخواست کوتاه‌تری بفرستید یا از مدل سریع‌تری استفاده کنید.";
    } else {
      console.error("Fetch Execution Error:", err);
      apiResponseText = "❌ خطا در برقراری ارتباط با سرور هوش مصنوعی.";
    }
  } finally {
    clearTimeout(timeoutId);
    isDone = true;
    await safeKvDelete(env, `CANCEL_${reqId}`);
  }

  await timerPromise;

  if (apiResponseText && !apiResponseText.startsWith("❌")) {
    let finalOutput = apiResponseText;
    if (isGroup) {
      const userMention = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || "کاربر");
      finalOutput = `👤 کاربر درخواست‌کننده: ${userMention}\n🤖 مدل: ${activeModel.name}\n-------------------\n\n${apiResponseText}`;
    }

    await sendSafeAIResponse(botToken, chatId, statusMsgId, finalOutput, replyToUse);
  } else {
    const isCancelledFinal = wasCancelled || (await safeKvGet(env, `CANCEL_${reqId}`)) === "true";
    if (!isCancelledFinal) {
      await tgRequest(botToken, "editMessageText", {
        chat_id: chatId,
        message_id: statusMsgId,
        text: apiResponseText || "❌ ارتباط با API برقرار نشد یا سرویس پاسخگو نبود."
      });
    }
  }
}

async function sendSafeAIResponse(botToken, chatId, messageId, text, replyToMessageId = null) {
  let editPayload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown"
  };

  if (text.length <= 4000) {
    let res = await tgRequest(botToken, "editMessageText", editPayload);
    if (!res.ok) {
      delete editPayload.parse_mode;
      await tgRequest(botToken, "editMessageText", editPayload);
    }
  } else {
    await tgRequest(botToken, "deleteMessage", { chat_id: chatId, message_id: messageId });
    const chunks = chunkString(text, 3800);
    for (const chunk of chunks) {
      let sendPayload = {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown"
      };
      if (replyToMessageId) {
        sendPayload.reply_to_message_id = replyToMessageId;
        sendPayload.allow_sending_without_reply = true;
      }
      let res = await tgRequest(botToken, "sendMessage", sendPayload);
      if (!res.ok) {
        delete sendPayload.parse_mode;
        await tgRequest(botToken, "sendMessage", sendPayload);
      }
    }
  }
}

function chunkString(str, size) {
  const numChunks = Math.ceil(str.length / size);
  const chunks = new Array(numChunks);
  for (let i = 0, c = 0; c < numChunks; ++c, i += size) {
    chunks[c] = str.substr(i, size);
  }
  return chunks;
}

// ==========================================
// ۴. پردازش ساخت عکس
// ==========================================
async function processImageRequest(botToken, env, chatId, userId, promptText, targetKeyId) {
  const imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
  let imgIdx = parseInt((await safeKvGet(env, `USER_IMG_MODEL_${targetKeyId}`)) || (await safeKvGet(env, `USER_IMG_MODEL_${userId}`)) || "0", 10);
  if (!Array.isArray(imgModels) || !imgModels[imgIdx]) imgIdx = 0;
  if (!imgModels.length || !imgModels[imgIdx]) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "⚠️ هیچ مدل تصویرسازی تعریف نشده است." });
    return;
  }
  if (!String(promptText || "").trim()) {
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "لطفاً توضیح تصویر موردنظرت را بنویس." });
    return;
  }
  if (String(promptText).length > 3000) promptText = String(promptText).slice(0, 3000);

  const model = imgModels[imgIdx];
  const statusRes = await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🎨 در حال ساخت تصویر..." });
  const statusMsgId = statusRes.result?.message_id;
  let imageUrl = null;
  let base64Image = null;
  let errorMessage = "سرویس تصویر پاسخی قابل استفاده برنگرداند.";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    const modelName = String(model.modelName || "").trim();
    const baseUrl = String(model.baseUrl || "").trim().replace(/\/+$/, "");
    const apiKey = String(model.apiKey || "").trim();
    if (!isValidHttpsUrl(baseUrl)) throw new Error("آدرس API باید یک URL معتبر HTTPS باشد.");

    if (new URL(baseUrl).hostname === "image.pollinations.ai" || new URL(baseUrl).hostname.endsWith(".pollinations.ai")) {
      const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptText)}`;
      const response = await fetch(pollinationsUrl, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`خطای Pollinations: ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) throw new Error("سرویس تصویر خروجی تصویری برنگرداند.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 10 * 1024 * 1024) throw new Error("حجم تصویر بیشتر از حد مجاز است.");
      base64Image = bytesToBase64(bytes);
    } else {
      const endpoint = baseUrl.endsWith("/images/generations") ? baseUrl : `${baseUrl}/images/generations`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: modelName, prompt: promptText, n: 1, size: "1024x1024" }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`خطای سرویس تصویر: ${response.status}`);
      const data = await response.json();
      const item = data?.data?.[0];
      if (item?.url && isValidHttpsUrl(item.url)) imageUrl = item.url;
      else if (item?.b64_json && /^[A-Za-z0-9+/=]+$/.test(item.b64_json)) base64Image = item.b64_json;
      else throw new Error("پاسخ API تصویر شامل URL معتبر یا b64_json نیست.");
    }
  } catch (e) {
    errorMessage = e?.name === "AbortError" ? "زمان ساخت تصویر تمام شد؛ لطفاً دوباره تلاش کنید." : (e?.message || errorMessage);
  } finally {
    clearTimeout(timeout);
  }

  const caption = `تصویر تولیدشده با ${String(model.name || model.modelName || "مدل تصویر") }
پرامپت: ${String(promptText).slice(0, 800)}`;
  let sendResult;
  if (imageUrl) {
    sendResult = await tgRequest(botToken, "sendPhoto", { chat_id: chatId, photo: imageUrl, caption: caption.slice(0, 1000) });
  } else if (base64Image) {
    const bytes = base64ToBytes(base64Image);
    if (bytes.length > 10 * 1024 * 1024) {
      errorMessage = "حجم تصویر بیشتر از حد مجاز تلگرام است.";
    } else {
      sendResult = await sendTelegramPhotoBytes(botToken, chatId, bytes, caption.slice(0, 1000));
    }
  }

  if (sendResult?.ok) {
    if (statusMsgId) await tgRequest(botToken, "deleteMessage", { chat_id: chatId, message_id: statusMsgId });
  } else {
    const detail = sendResult ? "ارسال تصویر به تلگرام ناموفق بود." : errorMessage;
    if (statusMsgId) await tgRequest(botToken, "editMessageText", { chat_id: chatId, message_id: statusMsgId, text: `❌ ساخت یا ارسال تصویر ناموفق شد.\n${String(detail).slice(0, 700)}` });
    else await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `❌ ساخت تصویر ناموفق شد.\n${String(detail).slice(0, 700)}` });
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function sendTelegramPhotoBytes(botToken, chatId, bytes, caption) {
  try {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("photo", new Blob([bytes], { type: "image/png" }), "generated-image.png");
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(20000) });
    return await res.json();
  } catch (e) {
    console.error("Telegram photo upload failed:", e?.message || e);
    return { ok: false };
  }
}

// ==========================================
// ۵. پنل مدیریت ادمین و آمار (چینش دو تایی دکمه‌ها)
// ==========================================
async function sendAdminPanel(botToken, chatId) {
  const keyboard = [
    [
      { text: "📊 آمار کاربران", callback_data: "admin_stats" },
      { text: "➕ افزودن مدل چت", callback_data: "admin_add_model" }
    ],
    [
      { text: "🎨 افزودن مدل عکس", callback_data: "admin_add_img_model" },
      { text: "📋 لیست مدل‌ها", callback_data: "admin_list_models" }
    ],
    [
      { text: "✏️ ویرایش مدل‌ها", callback_data: "admin_edit_models_menu" },
      { text: "📢 افزودن اسپانسر", callback_data: "admin_add_sponsor" }
    ],
    [
      { text: "🗑 حذف اسپانسر", callback_data: "admin_del_sponsor_menu" },
      { text: "🚫 مسدودسازی کاربر", callback_data: "admin_ban_user" }
    ],
    [
      { text: "✅ رفع مسدودی", callback_data: "admin_unban_user" },
      { text: "🔙 منوی اصلی", callback_data: "main_menu" }
    ]
  ];

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: "🛠 **پنل مدیریت ربات**",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendBotStats(botToken, env, chatId) {
  const setUsers = await upstashCommand(env, ["SMEMBERS", "BOT_USERS_SET"]);
  const legacyUsers = parseJson(await safeKvGet(env, "BOT_USERS"), []);
  const users = [...new Set([
    ...(Array.isArray(setUsers) ? setUsers.map(String) : []),
    ...(Array.isArray(legacyUsers) ? legacyUsers.map(String) : [])
  ])];
  const totalUsers = users.length;
  
  let activeUsers = 0;
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;

  for (const uid of users) {
    const lastActive = await safeKvGet(env, `LAST_ACTIVE_${uid}`);
    if (lastActive && (now - parseInt(lastActive)) < twentyFourHours) {
      activeUsers++;
    }
  }

  const text = `📊 **آمار جامع کاربران ربات:**\n\n👥 کل کاربران ثبت‌نامی: **${totalUsers}**\n🟢 کاربران آنلاین / فعال (۲۴ ساعت گذشته): **${activeUsers}**`;
  const keyboard = [[{ text: "🔙 بازگشت به پنل ادمین", callback_data: "admin_panel" }]];

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminModelsList(botToken, env, chatId, messageId = null) {
  const chatModels = parseJson(await safeKvGet(env, "AI_MODELS"), []);
  const imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
  let keyboard = [];
  let currentRow = [];

  chatModels.forEach((m, idx) => {
    currentRow.push({ text: `🗑 چت: ${m.name}`, callback_data: `del_model_${idx}` });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  imgModels.forEach((m, idx) => {
    currentRow.push({ text: `🗑 عکس: ${m.name}`, callback_data: `del_img_model_${idx}` });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }
  keyboard.push([{ text: "🔙 پنل ادمین", callback_data: "admin_panel" }]);

  const text = "📋 **لیست و حذف مدل‌ها:**";
  if (messageId) {
    await tgRequest(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    await tgRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

async function sendAdminEditModelsList(botToken, env, chatId) {
  const chatModels = parseJson(await safeKvGet(env, "AI_MODELS"), []);
  const imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
  let keyboard = [];
  let currentRow = [];

  chatModels.forEach((m, idx) => {
    currentRow.push({ text: `✏️ چت: ${m.name}`, callback_data: `edit_model_${idx}` });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  imgModels.forEach((m, idx) => {
    currentRow.push({ text: `✏️ عکس: ${m.name}`, callback_data: `edit_img_model_${idx}` });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }
  keyboard.push([{ text: "🔙 پنل ادمین", callback_data: "admin_panel" }]);

  await tgRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text: "✏️ **مدلی که قصد ویرایش آن را دارید انتخاب کنید:**",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminSponsorList(botToken, env, chatId, messageId = null) {
  const channels = parseJson(await safeKvGet(env, "SPONSOR_CHANNELS"), []);
  let listText = channels.length === 0 ? "📢 هیچ کانال اسپانسری ثبت نشده است." : "📢 **لیست کانال‌های اسپانسری:**";
  
  let keyboard = [];
  let currentRow = [];
  channels.forEach((ch, idx) => {
    currentRow.push({ text: `🗑 ${ch}`, callback_data: `del_sponsor_${idx}` });
    if (currentRow.length === 2) {
      keyboard.push(currentRow);
      currentRow = [];
    }
  });
  if (currentRow.length > 0) {
    keyboard.push(currentRow);
  }
  keyboard.push([{ text: "🔙 پنل ادمین", callback_data: "admin_panel" }]);

  if (messageId) {
    await tgRequest(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: listText,
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    await tgRequest(botToken, "sendMessage", {
      chat_id: chatId,
      text: listText,
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

async function handleAdminSteps(botToken, env, chatId, userId, text, step) {
  if (step === "ADD_MODEL_NAME") {
    await safeKvPut(env, `TEMP_MODEL_${userId}`, JSON.stringify({ name: text }));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_MODEL_URL");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🌐 **URL BASE** مربوط به API را وارد کنید:" });
  } else if (step === "ADD_MODEL_URL") {
    if (!isValidHttpsUrl(text.trim())) { await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ URL باید HTTPS معتبر باشد. دوباره وارد کن." }); return; }
    let temp = parseJson(await safeKvGet(env, `TEMP_MODEL_${userId}`), {});
    temp.baseUrl = text.trim();
    await safeKvPut(env, `TEMP_MODEL_${userId}`, JSON.stringify(temp));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_MODEL_KEY");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔑 **API KEY** را وارد کنید:" });
  } else if (step === "ADD_MODEL_KEY") {
    let temp = parseJson(await safeKvGet(env, `TEMP_MODEL_${userId}`), {});
    temp.apiKey = text;
    await safeKvPut(env, `TEMP_MODEL_${userId}`, JSON.stringify(temp));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_MODEL_ID");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📌 **MODEL NAME** اصلی را وارد کنید:" });
  } else if (step === "ADD_MODEL_ID") {
    let temp = parseJson(await safeKvGet(env, `TEMP_MODEL_${userId}`), {});
    temp.modelName = text;
    await safeKvPut(env, `TEMP_MODEL_${userId}`, JSON.stringify(temp));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_MODEL_VISION");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "👁 آیا این مدل **Vision** دارد؟ (`yes` یا `no`)" });
  } else if (step === "ADD_MODEL_VISION") {
    let temp = parseJson(await safeKvGet(env, `TEMP_MODEL_${userId}`), {});
    temp.supportsVision = text.toLowerCase() === "yes";
    let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
    models.push(temp);
    await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
    await clearUserState(env, userId);
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `✅ مدل چت **${temp.name}** اضافه شد!` });
    await sendAdminPanel(botToken, chatId);
  } 
  else if (step === "ADD_IMG_NAME") {
    await safeKvPut(env, `TEMP_IMG_${userId}`, JSON.stringify({ name: text }));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_IMG_URL");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🌐 **URL BASE** تصویرساز را وارد کنید:" });
  } else if (step === "ADD_IMG_URL") {
    if (!isValidHttpsUrl(text.trim())) { await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ URL باید HTTPS معتبر باشد. دوباره وارد کن." }); return; }
    let temp = parseJson(await safeKvGet(env, `TEMP_IMG_${userId}`), {});
    temp.baseUrl = text.trim();
    await safeKvPut(env, `TEMP_IMG_${userId}`, JSON.stringify(temp));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_IMG_KEY");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔑 **API KEY** تصویرساز (اگر نیاز ندارد . بفرستید):" });
  } else if (step === "ADD_IMG_KEY") {
    let temp = parseJson(await safeKvGet(env, `TEMP_IMG_${userId}`), {});
    temp.apiKey = text === "." ? "" : text;
    await safeKvPut(env, `TEMP_IMG_${userId}`, JSON.stringify(temp));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "ADD_IMG_ID");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📌 **MODEL NAME** تصویرساز را وارد کنید:" });
  } else if (step === "ADD_IMG_ID") {
    let temp = parseJson(await safeKvGet(env, `TEMP_IMG_${userId}`), {});
    temp.modelName = text;
    let imgModels = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
    imgModels.push(temp);
    await safeKvPut(env, "IMAGE_MODELS", JSON.stringify(imgModels));
    await clearUserState(env, userId);
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `🎨 مدل عکس **${temp.name}** اضافه شد!` });
    await sendAdminPanel(botToken, chatId);
  }
  else if (step === "EDIT_MODEL_NAME") {
    const idx = await safeKvGet(env, `ADMIN_EDIT_IDX_${userId}`);
    let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
    if (text !== "." && models[idx]) models[idx].name = text;
    await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_MODEL_URL");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🌐 URL Base جدید (یا .):" });
  } else if (step === "EDIT_MODEL_URL") {
    const idx = await safeKvGet(env, `ADMIN_EDIT_IDX_${userId}`);
    let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
    if (text.trim() !== "." && !isValidHttpsUrl(text.trim())) { await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ URL باید HTTPS معتبر باشد. دوباره وارد کن یا . بفرست." }); return; }
    if (text.trim() !== "." && models[idx]) models[idx].baseUrl = text.trim();
    await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_MODEL_KEY");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔑 API Key جدید (یا .):" });
  } else if (step === "EDIT_MODEL_KEY") {
    const idx = await safeKvGet(env, `ADMIN_EDIT_IDX_${userId}`);
    let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
    if (text !== "." && models[idx]) models[idx].apiKey = text;
    await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_MODEL_ID");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📌 Model Name جدید (یا .):" });
  } else if (step === "EDIT_MODEL_ID") {
    const idx = await safeKvGet(env, `ADMIN_EDIT_IDX_${userId}`);
    let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
    if (text !== "." && models[idx]) models[idx].modelName = text;
    await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
    await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_MODEL_VISION");
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "👁 قابلیت Vision؟ (`yes` یا `no` یا .)" });
  } else if (step === "EDIT_MODEL_VISION") {
    const idx = await safeKvGet(env, `ADMIN_EDIT_IDX_${userId}`);
    let models = parseJson(await safeKvGet(env, "AI_MODELS"), []);
    if (text !== "." && models[idx]) models[idx].supportsVision = text.toLowerCase() === "yes";
    await safeKvPut(env, "AI_MODELS", JSON.stringify(models));
    await clearUserState(env, userId);
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "✅ مدل چت ویرایش شد!" });
    await sendAdminPanel(botToken, chatId);
  }
  else if (["EDIT_IMG_NAME", "EDIT_IMG_URL", "EDIT_IMG_KEY", "EDIT_IMG_ID"].includes(step)) {
    const idx = Number(await safeKvGet(env, `ADMIN_EDIT_IMG_IDX_${userId}`));
    const models = parseJson(await safeKvGet(env, "IMAGE_MODELS"), []);
    if (!Number.isInteger(idx) || idx < 0 || idx >= models.length) {
      await clearUserState(env, userId);
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ مدل تصویر پیدا نشد. دوباره از پنل مدیریت انتخاب کن." });
      return;
    }
    const model = models[idx];
    if (step === "EDIT_IMG_NAME") {
      if (text.trim() !== ".") model.name = text.trim().slice(0, 80);
      await safeKvPut(env, "IMAGE_MODELS", models);
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_IMG_URL");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🌐 URL Base جدید (یا . برای حفظ مقدار):" });
    } else if (step === "EDIT_IMG_URL") {
      if (text.trim() !== ".") {
        if (!isValidHttpsUrl(text.trim())) {
          await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ آدرس باید HTTPS معتبر باشد. دوباره وارد کن یا . بفرست." });
          return;
        }
        model.baseUrl = text.trim();
      }
      await safeKvPut(env, "IMAGE_MODELS", models);
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_IMG_KEY");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "🔑 API Key جدید (یا . برای حفظ مقدار؛ برای خالی کردن بنویس CLEAR):" });
    } else if (step === "EDIT_IMG_KEY") {
      if (text.trim() === "CLEAR") model.apiKey = "";
      else if (text.trim() !== ".") model.apiKey = text.trim();
      await safeKvPut(env, "IMAGE_MODELS", models);
      await safeKvPut(env, `ADMIN_STEP_${userId}`, "EDIT_IMG_ID");
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "📌 Model Name جدید (یا . برای حفظ مقدار):" });
    } else {
      if (text.trim() !== ".") model.modelName = text.trim().slice(0, 120);
      await safeKvPut(env, "IMAGE_MODELS", models);
      await clearUserState(env, userId);
      await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "✅ مدل تصویر ویرایش شد." });
      await sendAdminPanel(botToken, chatId);
    }
  }
  else if (step === "ADD_SPONSOR") {
    let channels = parseJson(await safeKvGet(env, "SPONSOR_CHANNELS"), []);
    const channelName = text.trim().startsWith("@") ? text.trim() : `@${text.trim()}`;
    if (!channels.includes(channelName)) {
      channels.push(channelName);
      await safeKvPut(env, "SPONSOR_CHANNELS", JSON.stringify(channels));
    }
    await clearUserState(env, userId);
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `📢 کانال اسپانسر ${channelName} اضافه شد.` });
    await sendAdminPanel(botToken, chatId);
  } else if (step === "BAN_USER") {
    if (!/^\d{1,20}$/.test(text.trim()) || text.trim() === userId) { await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ شناسه عددی معتبرِ کاربر دیگری را وارد کن." }); return; }
    await safeKvPut(env, `BANNED_${text.trim()}`, "true");
    await clearUserState(env, userId);
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `🚫 کاربر ${text} مسدود شد.` });
    await sendAdminPanel(botToken, chatId);
  } else if (step === "UNBAN_USER") {
    if (!/^\d{1,20}$/.test(text.trim())) { await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: "❌ شناسه باید عددی باشد." }); return; }
    await safeKvDelete(env, `BANNED_${text.trim()}`);
    await clearUserState(env, userId);
    await tgRequest(botToken, "sendMessage", { chat_id: chatId, text: `✅ کاربر ${text} رفع مسدودی شد.` });
    await sendAdminPanel(botToken, chatId);
  }
}

// ==========================================
// ۶. توابع کمکی
// ==========================================
async function trackUserActivity(env, userId) {
  // SADD is atomic and avoids lost updates when messages arrive concurrently.
  await upstashCommand(env, ["SADD", "BOT_USERS_SET", String(userId)]);
  await safeKvPut(env, `LAST_ACTIVE_${userId}`, Date.now().toString(), { expirationTtl: 7776000 });
}

async function clearUserState(env, userId) {
  await Promise.all([
    safeKvDelete(env, `ADMIN_STEP_${userId}`),
    safeKvDelete(env, `TEMP_MODEL_${userId}`),
    safeKvDelete(env, `TEMP_IMG_${userId}`),
    safeKvDelete(env, `ADMIN_EDIT_IDX_${userId}`),
    safeKvDelete(env, `ADMIN_EDIT_IMG_IDX_${userId}`),
    safeKvDelete(env, `TEMP_MODEL_${userId}`),
    safeKvDelete(env, `TEMP_IMG_${userId}`)
  ]);
}

async function getOrCreateActiveSession(env, userId) {
  let activeId = await safeKvGet(env, `ACTIVE_SESSION_${userId}`);
  if (!activeId) {
    activeId = `sess_${crypto.randomUUID()}`;
    await safeKvPut(env, `ACTIVE_SESSION_${userId}`, activeId);
    let sessions = parseJson(await safeKvGet(env, `SESSIONS_${userId}`), []);
    sessions.unshift({ id: activeId, title: "گفتگوی جدید 💬", date: new Date().toLocaleDateString('fa-IR') });
    sessions = sessions.slice(0, 30);
    await safeKvPut(env, `SESSIONS_${userId}`, JSON.stringify(sessions));
  }
  return activeId;
}

async function updateSessionTitleIfNew(env, userId, sessionId, firstMsg) {
  let sessions = parseJson(await safeKvGet(env, `SESSIONS_${userId}`), []);
  const session = sessions.find(s => s.id === sessionId);
  if (session && session.title === "گفتگوی جدید 💬") {
    session.title = firstMsg.slice(0, 22) + (firstMsg.length > 22 ? "..." : "");
    await safeKvPut(env, `SESSIONS_${userId}`, JSON.stringify(sessions));
  }
}

async function tgRequest(token, method, body) {
  if (!token) return { ok: false, description: "Missing bot token" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      if (res.status >= 500 || res.status === 429) console.error("Telegram API error:", method, res.status, data?.description || "");
      return data || { ok: false, description: `Telegram HTTP ${res.status}` };
    }
    return data;
  } catch (e) {
    console.error("TG Request Error:", method, e?.message || e);
    return { ok: false, description: e?.message || "Telegram request failed" };
  }
}

async function checkSponsorJoin(botToken, env, userId) {
  const channelsRaw = await safeKvGet(env, "SPONSOR_CHANNELS");
  let channels = [];
  try {
    channels = JSON.parse(channelsRaw) || [];
  } catch (e) {
    if (channelsRaw) channels = [channelsRaw];
  }

  if (channels.length === 0) return { ok: true, unjoined: [] };

  let unjoined = [];
  for (const ch of channels) {
    const formattedCh = ch.startsWith("@") ? ch : `@${ch}`;
    try {
      const res = await tgRequest(botToken, "getChatMember", {
        chat_id: formattedCh,
        user_id: userId
      });
      const member = res.result;
      const isMember = res.ok && ( ["creator", "administrator", "member"].includes(member?.status) || (member?.status === "restricted" && member?.is_member === true) );
      if (!isMember) unjoined.push(formattedCh);
    } catch (e) {}
  }

  return { ok: unjoined.length === 0, unjoined };
}

async function getTelegramFileBase64(botToken, fileId) {
  try {
    const fileResJson = await tgRequest(botToken, "getFile", { file_id: fileId });
    if (!fileResJson.ok || !fileResJson.result?.file_path) return null;
    if (fileResJson.result.file_size && fileResJson.result.file_size > 8 * 1024 * 1024) return null;
    const filePath = fileResJson.result.file_path;
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 8 * 1024 * 1024) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 8 * 1024 * 1024) return null;
    return bytesToBase64(new Uint8Array(buffer));
  } catch (e) {
    console.error("Base64 Error:", e?.message || e);
    return null;
  }
}

async function getTelegramFileText(botToken, fileId) {
  try {
    const fileResJson = await tgRequest(botToken, "getFile", { file_id: fileId });
    if (!fileResJson.ok || !fileResJson.result?.file_path) return null;
    if (fileResJson.result.file_size && fileResJson.result.file_size > 512 * 1024) return null;
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileResJson.result.file_path}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 512 * 1024) return null;
    const text = await response.text();
    return text.length <= 512 * 1024 ? text : null;
  } catch (e) {
    console.error("Text file download error:", e?.message || e);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
