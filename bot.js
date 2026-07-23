const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
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
    keyboard: [
      ["📧 New Mail", "📥 Inbox"],
      ["ℹ️ My Email", "🗑 Delete"],
      ["❓ Help"],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

async function createEmail() {
  const res = await fetch(
    "https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1"
  );
  if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
  const data = await res.json();
  if (!data || !data[0]) throw new Error("No email generated");
  const email = data[0];
  const [login, domain] = email.split("@");
  return { email, login, domain };
}

async function getMessages(login, domain) {
  const res = await fetch(
    `https://www.1secmail.com/api/v1/?action=getMessages&login=\( {login}&domain= \){domain}`
  );
  if (!res.ok) throw new Error(`Inbox failed: ${res.status}`);
  return res.json();
}

async function readMessage(login, domain, id) {
  const res = await fetch(
    `https://www.1secmail.com/api/v1/?action=readMessage&login=\( {login}&domain= \){domain}&id=${id}`
  );
  if (!res.ok) throw new Error(`Read failed: ${res.status}`);
  return res.json();
}

// /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";
  await bot.sendMessage(
    chatId,
    `👋 *Welcome, ${name}!*\n\n📬 I'm your *Temp Mail Bot*\n\nUse the buttons below:`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() }
  );
});

// Buttons
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Help
  if (text === "❓ Help" || text === "Help") {
    await bot.sendMessage(
      chatId,
      `🤖 *Help*\n\n📧 New Mail — Generate email\n📥 Inbox — Check emails\nℹ️ My Email — Show current\n🗑 Delete — Remove session`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
    return;
  }

  // New Mail
  if (text === "📧 New Mail" || text === "New Mail") {
    if (sessions[chatId]) {
      await bot.sendMessage(
        chatId,
        `⚠️ Already have:\n\`${sessions[chatId].email}\`\n\nDelete first.`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

    await bot.sendMessage(chatId, "⏳ Generating...", {
      reply_markup: mainKeyboard(),
    });

    try {
      const { email, login, domain } = await createEmail();
      sessions[chatId] = { email, login, domain };

      await bot.sendMessage(
        chatId,
        `✅ *Ready!*\n\n📧 \`${email}\`\n\n👆 Tap to copy`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
    } catch (err) {
      console.error("NEWMAIL ERROR:", err);
      await bot.sendMessage(
        chatId,
        `❌ ${err.message}\n\nTry again.`,
        { reply_markup: mainKeyboard() }
      );
    }
    return;
  }

  // My Email
  if (text === "ℹ️ My Email" || text === "My Email") {
    if (!sessions[chatId]) {
      await bot.sendMessage(chatId, "❌ No email. Create one first.", {
        reply_markup: mainKeyboard(),
      });
      return;
    }
    await bot.sendMessage(
      chatId,
      `📧 *Current:*\n\`${sessions[chatId].email}\``,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
    return;
  }

  // Inbox
  if (text === "📥 Inbox" || text === "Inbox") {
    if (!sessions[chatId]) {
      await bot.sendMessage(chatId, "❌ No email. Create one first.", {
        reply_markup: mainKeyboard(),
      });
      return;
    }

    await bot.sendMessage(chatId, "🔄 Checking...", {
      reply_markup: mainKeyboard(),
    });

    try {
      const messages = await getMessages(
        sessions[chatId].login,
        sessions[chatId].domain
      );

      if (!messages || messages.length === 0) {
        await bot.sendMessage(
          chatId,
          `📭 *Empty*\n\n\`${sessions[chatId].email}\``,
          { parse_mode: "Markdown", reply_markup: mainKeyboard() }
        );
        return;
      }

      sessions[chatId].messages = messages;

      let list = `📬 *${messages.length} email(s)*\n\n`;
      messages.forEach((m, i) => {
        list += `*\( {i + 1}.* From: \` \){m.from}\`\n`;
        list += `    ${escapeMarkdown(m.subject || "No subject")}\n\n`;
      });
      list += `Reply with number (1, 2, 3...) to read.`;

      await bot.sendMessage(chatId, list, {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard(),
      });
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, `❌ ${err.message}`, {
        reply_markup: mainKeyboard(),
      });
    }
    return;
  }

  // Read by number
  if (/^\d+$/.test(text) && sessions[chatId]?.messages) {
    const index = parseInt(text) - 1;
    if (!sessions[chatId].messages[index]) {
      await bot.sendMessage(chatId, "❌ Invalid number.", {
        reply_markup: mainKeyboard(),
      });
      return;
    }

    try {
      const msgData = sessions[chatId].messages[index];
      const full = await readMessage(
        sessions[chatId].login,
        sessions[chatId].domain,
        msgData.id
      );

      let rawBody = full.textBody || full.htmlBody || "(Empty)";
      if (full.htmlBody && !full.textBody) {
        rawBody = stripHtml(full.htmlBody);
      }
      rawBody = rawBody.substring(0, 4000);

      const otp = detectOtp(rawBody);

      await bot.sendMessage(
        chatId,
        `📩 *#\( {index + 1}*\nFrom: \` \){full.from}\`\nSubject: ${escapeMarkdown(
          full.subject || "—"
        )}` + (otp ? `\n🔐 OTP: \`${otp}\`` : ""),
        { parse_mode: "Markdown" }
      );

      await bot.sendMessage(chatId, rawBody, {
        disable_web_page_preview: true,
        reply_markup: mainKeyboard(),
      });
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, `❌ ${err.message}`, {
        reply_markup: mainKeyboard(),
      });
    }
    return;
  }

  // Delete
  if (text === "🗑 Delete" || text === "Delete") {
    if (!sessions[chatId]) {
      await bot.sendMessage(chatId, "❌ Nothing to delete.", {
        reply_markup: mainKeyboard(),
      });
      return;
    }
    delete sessions[chatId];
    await bot.sendMessage(chatId, "🗑 *Deleted.*", {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
    return;
  }

  // Fallback
  await bot.sendMessage(chatId, "💡 Use the buttons below.", {
    reply_markup: mainKeyboard(),
  });
});

console.log("🤖 Temp Mail Bot running...");
module.exports = bot;