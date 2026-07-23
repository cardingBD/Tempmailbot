const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAILTM = "https://api.mail.gw";

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

async function getDomains() {
  const res = await fetch(`${MAILTM}/domains`, {
    headers: { "User-Agent": "TempMailBot/1.0" },
  });
  if (!res.ok) throw new Error(`Domains failed: ${res.status}`);
  const data = await res.json();
  return data["hydra:member"] || [];
}

async function createAccount() {
  const domains = await getDomains();
  if (!domains.length) throw new Error("No domains available");

  for (let i = 0; i < 8; i++) {
    const domain = domains[Math.floor(Math.random() * domains.length)].domain;
    const address = `\( {randomString(12)}@ \){domain}`;
    const password = randomString(16);

    const res = await fetch(`${MAILTM}/accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "TempMailBot/1.0",
      },
      body: JSON.stringify({ address, password }),
    });

    const text = await res.text();
    if (!text) continue;

    let account;
    try {
      account = JSON.parse(text);
    } catch {
      continue;
    }

    if (account && account.id) {
      return { address, password, account };
    }

    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error("Could not create account after retries");
}

async function getToken(address, password) {
  const res = await fetch(`${MAILTM}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "TempMailBot/1.0",
    },
    body: JSON.stringify({ address, password }),
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status}`);
  return res.json();
}

async function safeJson(res) {
  const text = await res.text();
  if (!text || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getMessages(token) {
  const res = await fetch(`${MAILTM}/messages`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "TempMailBot/1.0",
    },
  });
  return safeJson(res);
}

async function getMessage(token, id) {
  const res = await fetch(`\( {MAILTM}/messages/ \){id}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "TempMailBot/1.0",
    },
  });
  return safeJson(res);
}

async function deleteAccount(token, accountId) {
  await fetch(`\( {MAILTM}/accounts/ \){accountId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "TempMailBot/1.0",
    },
  });
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

// Button handlers
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
      const { address, password, account } = await createAccount();
      const tokenData = await getToken(address, password);

      if (!tokenData.token) {
        throw new Error("No token received");
      }

      sessions[chatId] = {
        email: address,
        password,
        token: tokenData.token,
        accountId: account.id,
      };

      await bot.sendMessage(
        chatId,
        `✅ *Ready!*\n\n📧 \`${address}\`\n\n👆 Tap to copy`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
    } catch (err) {
      console.error("NEWMAIL ERROR:", err);
      await bot.sendMessage(
        chatId,
        `❌ ${err.message || "Unknown error"}\n\nTry again in a few seconds.`,
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
      const result = await getMessages(sessions[chatId].token);

      if (!result || !result["hydra:member"]) {
        await bot.sendMessage(chatId, "⚠️ Could not reach mail server.", {
          reply_markup: mainKeyboard(),
        });
        return;
      }

      const messages = result["hydra:member"];

      if (!messages.length) {
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
        list += `*\( {i + 1}.* From: \` \){m.from.address}\`\n`;
        list += `    ${escapeMarkdown(m.subject || "No subject")}\n\n`;
      });
      list += `Reply with number (1, 2, 3...) to read.`;

      await bot.sendMessage(chatId, list, {
        parse_mode: "Markdown",
        reply_markup: mainKeyboard(),
      });
    } catch (err) {
      console.error(err);
      await bot.sendMessage(chatId, "❌ Inbox failed.", {
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
      const full = await getMessage(
        sessions[chatId].token,
        sessions[chatId].messages[index].id
      );

      if (!full) {
        await bot.sendMessage(chatId, "⚠️ Could not fetch email.", {
          reply_markup: mainKeyboard(),
        });
        return;
      }

      let rawBody = "(Empty)";
      if (full.text) {
        rawBody = full.text.substring(0, 4000);
      } else if (full.html) {
        const htmlStr = Array.isArray(full.html)
          ? full.html.map((h) => (typeof h === "string" ? h : h.value || "")).join(" ")
          : String(full.html);
        rawBody = stripHtml(htmlStr).substring(0, 4000);
      }

      const otp = detectOtp(rawBody);

      await bot.sendMessage(
        chatId,
        `📩 *#\( {index + 1}*\nFrom: \` \){full.from.address}\`\nSubject: ${escapeMarkdown(
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
      await bot.sendMessage(chatId, "❌ Read failed.", {
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

  // Fallback
  await bot.sendMessage(chatId, "💡 Use the buttons below.", {
    reply_markup: mainKeyboard(),
  });
});

console.log("🤖 Temp Mail Bot running...");
module.exports = bot;