const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAILTM = "https://api.mail.tm";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sessions = {};

function randomString(len = 10) {
  return Math.random().toString(36).substring(2, 2 + len);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/ {2,}/g, " ")
    .trim();
}

function detectOtp(text) {
  const match = text.match(/\b(\d{4,8})\b/);
  return match ? match[1] : null;
}

function escapeMarkdown(text) {
  return text.replace(/[_*`[\]()\~>#+=|{}.!-]/g, "\\$&");
}

function mainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📧 New Mail", callback_data: "newmail" },
        { text: "📥 Inbox", callback_data: "inbox" },
      ],
      [
        { text: "ℹ️ My Email", callback_data: "myemail" },
        { text: "🗑 Delete", callback_data: "delete" },
      ],
      [{ text: "❓ Help", callback_data: "help" }],
    ],
  };
}

async function getDomain() {
  const res = await fetch(`${MAILTM}/domains?page=1`);
  const data = await res.json();
  return data["hydra:member"][0].domain;
}

async function getToken(address, password) {
  const res = await fetch(`${MAILTM}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password }),
  });
  return res.json();
}

async function safeJson(res) {
  const text = await res.text();
  if (!text || text.trim() === "") return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function getMessages(token) {
  const res = await fetch(`${MAILTM}/messages?page=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return safeJson(res);
}

async function getMessage(token, id) {
  const res = await fetch(`\( {MAILTM}/messages/ \){id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return safeJson(res);
}

async function deleteAccount(token, accountId) {
  await fetch(`\( {MAILTM}/accounts/ \){accountId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";
  await bot.sendMessage(
    chatId,
    `👋 *Welcome, ${name}!*\n\n📬 I'm your *Temp Mail Bot*\n\nUse the buttons below:`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() }
  );
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data === "help") {
    await bot.sendMessage(chatId,
      `🤖 *Help*\n\n📧 New Mail — Generate email\n📥 Inbox — Check emails\nℹ️ My Email — Show current\n🗑 Delete — Remove session`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
    return;
  }

  if (data === "newmail") {
    if (sessions[chatId]) {
      await bot.sendMessage(chatId,
        `⚠️ Already have:\n\`${sessions[chatId].email}\`\n\nDelete first.`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }
    await bot.sendMessage(chatId, "⏳ Generating...");
    try {
      const domain = await getDomain();
      let account, address, password;
      for (let i = 0; i < 3; i++) {
        address = `\( {randomString(12)}@ \){domain}`;
        password = randomString(16);
        const res = await fetch(`${MAILTM}/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, password }),
        });
        const text = await res.text();
        if (!text) continue;
        account = JSON.parse(text);
        if (account.id) break;
      }
      if (!account?.id) {
        await bot.sendMessage(chatId, "❌ Failed. Try again.", { reply_markup: mainKeyboard() });
        return;
      }
      const tokenData = await getToken(address, password);
      if (!tokenData.token) {
        await bot.sendMessage(chatId, "❌ Auth failed.", { reply_markup: mainKeyboard() });
        return;
      }
      sessions[chatId] = { email: address, password, token: tokenData.token, accountId: account.id };
      await bot.sendMessage(chatId,
        `✅ *Ready!*\n\n📧 \`${address}\`\n\n👆 Tap to copy`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, "❌ Error. Try again.", { reply_markup: mainKeyboard() });
    }
    return;
  }

  if (data === "myemail") {
    if (!sessions[chatId]) {
      await bot.sendMessage(chatId, "❌ No email. Create one first.", { reply_markup: mainKeyboard() });
      return;
    }
    await bot.sendMessage(chatId,
      `📧 *Current:*\n\`${sessions[chatId].email}\``,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
    return;
  }

  if (data === "inbox") {
    if (!sessions[chatId]) {
      await bot.sendMessage(chatId, "❌ No email. Create one first.", { reply_markup: mainKeyboard() });
      return;
    }
    await bot.sendMessage(chatId, "🔄 Checking...");
    try {
      const result = await getMessages(sessions[chatId].token);
      if (!result?.["hydra:member"]) {
        await bot.sendMessage(chatId, "⚠️ Server error.", { reply_markup: mainKeyboard() });
        return;
      }
      const messages = result["hydra:member"];
      if (!messages.length) {
        await bot.sendMessage(chatId,
          `📭 *Empty*\n\n\`${sessions[chatId].email}\``,
          { parse_mode: "Markdown", reply_markup: mainKeyboard() }
        );
        return;
      }
      sessions[chatId].messages = messages;
      const keyboard = messages.map((m, i) => [{
        text: `${i + 1}. ${(m.subject || "No subject").substring(0, 40)}`,
        callback_data: `read_${i}`,
      }]);
      keyboard.push([{ text: "🔙 Menu", callback_data: "menu" }]);
      await bot.sendMessage(chatId,
        `📬 *${messages.length} email(s)*\n\nTap to read:`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
      );
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, "❌ Inbox failed.", { reply_markup: mainKeyboard() });
    }
    return;
  }

  if (data.startsWith("read_")) {
    const index = parseInt(data.split("_")[1]);
    if (!sessions[chatId]?.messages?.[index]) {
      await bot.sendMessage(chatId, "❌ Invalid.", { reply_markup: mainKeyboard() });
      return;
    }
    try {
      const full = await getMessage(sessions[chatId].token, sessions[chatId].messages[index].id);
      if (!full) {
        await bot.sendMessage(chatId, "⚠️ Fetch failed.", { reply_markup: mainKeyboard() });
        return;
      }
      let rawBody = full.text
        ? full.text.substring(0, 4000)
        : full.html
        ? stripHtml(Array.isArray(full.html) ? full.html.map(h => h.value || h).join(" ") : full.html).substring(0, 4000)
        : "(Empty)";
      const otp = detectOtp(rawBody);
      await bot.sendMessage(chatId,
        `📩 *#\( {index + 1}*\nFrom: \` \){full.from.address}\`\nSubject: ${escapeMarkdown(full.subject || "—")}` +
        (otp ? `\n🔐 OTP: \`${otp}\`` : ""),
        { parse_mode: "Markdown" }
      );
      await bot.sendMessage(chatId, rawBody, {
        disable_web_page_preview: true,
        reply_markup: mainKeyboard(),
      });
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, "❌ Read failed.", { reply_markup: mainKeyboard() });
    }
    return;
  }

  if (data === "delete") {
    if (!sessions[chatId]) {
      await bot.sendMessage(chatId, "❌ Nothing to delete.", { reply_markup: mainKeyboard() });
      return;
    }
    try {
      await deleteAccount(sessions[chatId].token, sessions[chatId].accountId);
    } catch (e) {}
    delete sessions[chatId];
    await bot.sendMessage(chatId, "🗑 *Deleted.*", {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
    return;
  }

  if (data === "menu") {
    await bot.sendMessage(chatId, "🏠 Menu", {
      reply_markup: mainKeyboard(),
    });
  }
});

bot.on("message", (msg) => {
  if (msg.text && !msg.text.startsWith("/")) {
    bot.sendMessage(msg.chat.id, "💡 Use buttons:", { reply_markup: mainKeyboard() });
  }
});

console.log("🤖 Temp Mail Bot running...");
module.exports = bot;