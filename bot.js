const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MAILTM = "https://api.mail.tm";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Store per-user session
const sessions = {};

// ─── Helpers ────────────────────────────────────────────────────────────────

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

async function getDomain() {
  const res = await fetch(`${MAILTM}/domains?page=1`);
  const data = await res.json();
  return data["hydra:member"][0].domain;
}

async function createAccount(address, password) {
  const res = await fetch(`${MAILTM}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, password }),
  });
  return res.json();
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
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
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

// ─── /start ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";

  await bot.sendMessage(
    chatId,
    `👋 *Welcome, ${name}!*\n\n` +
      `📬 I'm your *Temp Mail Bot* — get disposable email addresses instantly!\n\n` +
      `Use the buttons below:`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() }
  );
});

// ─── Help ───────────────────────────────────────────────────────────────────

async function showHelp(chatId) {
  await bot.sendMessage(
    chatId,
    `🤖 *Temp Mail Bot — Help*\n\n` +
      `📧 New Mail — Generate a new disposable email\n` +
      `📥 Inbox — Check received emails\n` +
      `ℹ️ My Email — Show your current email\n` +
      `🗑 Delete — Delete current email & session\n\n` +
      `_Emails are temporary and will be lost on delete or restart._`,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() }
  );
}

bot.onText(/\/help/, async (msg) => {
  await showHelp(msg.chat.id);
});

// ─── New Mail ───────────────────────────────────────────────────────────────

async function createNewMail(chatId) {
  if (sessions[chatId]) {
    await bot.sendMessage(
      chatId,
      `⚠️ You already have an active email:\n\`${sessions[chatId].email}\`\n\n` +
        `Use Delete first to generate a new one.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
    return;
  }

  await bot.sendMessage(chatId, "⏳ Generating your temp email...", {
    reply_markup: mainKeyboard(),
  });

  try {
    const domain = await getDomain();

    let account, address, password;
    for (let attempt = 0; attempt < 3; attempt++) {
      const username = randomString(12);
      address = `\( {username}@ \){domain}`;
      password = randomString(16);

      try {
        const res = await fetch(`${MAILTM}/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, password }),
        });
        const text = await res.text();
        if (!text) continue;
        account = JSON.parse(text);
        if (account.id) break;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }

    if (!account || !account.id) {
      await bot.sendMessage(
        chatId,
        "❌ Failed to create email after 3 attempts. Please try again.",
        { reply_markup: mainKeyboard() }
      );
      return;
    }

    const tokenData = await getToken(address, password);

    if (!tokenData.token) {
      await bot.sendMessage(chatId, "❌ Failed to authenticate. Please try again.", {
        reply_markup: mainKeyboard(),
      });
      return;
    }

    sessions[chatId] = {
      email: address,
      password,
      token: tokenData.token,
      accountId: account.id,
    };

    await bot.sendMessage(
      chatId,
      `✅ *Your Temp Email is Ready!*\n\n` +
        `📧 \`${address}\`\n\n` +
        `👆 Tap to copy!`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "❌ Something went wrong. Please try again.", {
      reply_markup: mainKeyboard(),
    });
  }
}

bot.onText(/\/newmail/, async (msg) => {
  await createNewMail(msg.chat.id);
});

// ─── My Email ───────────────────────────────────────────────────────────────

async function showMyEmail(chatId) {
  if (!sessions[chatId]) {
    await bot.sendMessage(chatId, "❌ No active email. Create one first.", {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  await bot.sendMessage(
    chatId,
    `📧 *Your current email:*\n\`${sessions[chatId].email}\``,
    { parse_mode: "Markdown", reply_markup: mainKeyboard() }
  );
}

bot.onText(/\/myemail/, async (msg) => {
  await showMyEmail(msg.chat.id);
});

// ─── Inbox ──────────────────────────────────────────────────────────────────

async function showInbox(chatId) {
  if (!sessions[chatId]) {
    await bot.sendMessage(chatId, "❌ No active email. Create one first.", {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  await bot.sendMessage(chatId, "🔄 Checking your inbox...", {
    reply_markup: mainKeyboard(),
  });

  try {
    const data = await getMessages(sessions[chatId].token);

    if (!data || !data["hydra:member"]) {
      await bot.sendMessage(
        chatId,
        "⚠️ Could not reach mail server. Please try again in a moment.",
        { reply_markup: mainKeyboard() }
      );
      return;
    }

    const messages = data["hydra:member"];

    if (!messages || messages.length === 0) {
      await bot.sendMessage(
        chatId,
        `📭 *Inbox is empty.*\n\nNo emails received yet for:\n\`${sessions[chatId].email}\``,
        { parse_mode: "Markdown", reply_markup: mainKeyboard() }
      );
      return;
    }

    sessions[chatId].messages = messages;

    let text =
      `📬 *You have ${messages.length} email(s):*\n\n` +
      messages
        .map(
          (m, i) =>
            `*\( {i + 1}.* 📩 From: \` \){m.from.address}\`\n` +
            `    📌 Subject: ${escapeMarkdown(m.subject || "(No subject)")}\n` +
            `    🕐 ${new Date(m.createdAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })}`
        )
        .join("\n\n") +
      `\n\nReply with the number (1, 2, 3...) to read a message`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      reply_markup: mainKeyboard(),
    });
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "❌ Failed to fetch inbox. Try again.", {
      reply_markup: mainKeyboard(),
    });
  }
}

bot.onText(/\/inbox/, async (msg) => {
  await showInbox(msg.chat.id);
});

// ─── Read ───────────────────────────────────────────────────────────────────

bot.onText(/\/read_(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const index = parseInt(match[1]) - 1;
  await readEmail(chatId, index);
});

async function readEmail(chatId, index) {
  if (!sessions[chatId]) {
    await bot.sendMessage(chatId, "❌ No active session. Create one first.", {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  if (!sessions[chatId].messages || !sessions[chatId].messages[index]) {
    await bot.sendMessage(chatId, "❌ Invalid message number.", {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  try {
    const msgId = sessions[chatId].messages[index].id;
    const full = await getMessage(sessions[chatId].token, msgId);

    if (!full) {
      await bot.sendMessage(chatId, "⚠️ Could not fetch email.", {
        reply_markup: mainKeyboard(),
      });
      return;
    }

    let rawBody = "";
    if (full.text) {
      rawBody = full.text.substring(0, 4000);
    } else if (full.html) {
      const htmlStr = Array.isArray(full.html)
        ? full.html.map((h) => (typeof h === "string" ? h : h.value || "")).join(" ")
        : typeof full.html === "string"
        ? full.html
        : "";
      rawBody = stripHtml(htmlStr).substring(0, 4000);
    } else {
      rawBody = "(Empty message)";
    }

    const otp = detectOtp(rawBody);
    const otpLine = otp ? `\n🔐 OTP Detected: \`${otp}\`\n` : "";
    const safeSubject = escapeMarkdown(full.subject || "(No subject)");

    await bot.sendMessage(
      chatId,
      `📩 *Email #${index + 1}*\n\n` +
        `*From:* \`${full.from.address}\`\n` +
        `*Subject:* ${safeSubject}\n` +
        `*Date:* ${new Date(full.createdAt).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        })}` +
        otpLine,
      { parse_mode: "Markdown" }
    );

    await bot.sendMessage(chatId, `─────────────────\n${rawBody}`, {
      disable_web_page_preview: true,
      reply_markup: mainKeyboard(),
    });
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "❌ Failed to read message.", {
      reply_markup: mainKeyboard(),
    });
  }
}

// ─── Delete ─────────────────────────────────────────────────────────────────

async function deleteMail(chatId) {
  if (!sessions[chatId]) {
    await bot.sendMessage(chatId, "❌ No active email to delete.", {
      reply_markup: mainKeyboard(),
    });
    return;
  }

  try {
    await deleteAccount(sessions[chatId].token, sessions[chatId].accountId);
    delete sessions[chatId];

    await bot.sendMessage(
      chatId,
      `🗑 *Email deleted successfully!*\n\nUse New Mail to generate a fresh one.`,
      { parse_mode: "Markdown", reply_markup: mainKeyboard() }
    );
  } catch (err) {
    delete sessions[chatId];
    await bot.sendMessage(chatId, "🗑 Session cleared.", {
      reply_markup: mainKeyboard(),
    });
  }
}

bot.onText(/\/delete/, async (msg) => {
  await deleteMail(msg.chat.id);
});

// ─── Button text handlers ───────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "📧 New Mail" || text === "New Mail") {
    await createNewMail(chatId);
  } else if (text === "📥 Inbox" || text === "Inbox") {
    await showInbox(chatId);
  } else if (text === "ℹ️ My Email" || text === "My Email") {
    await showMyEmail(chatId);
  } else if (text === "🗑 Delete" || text === "Delete") {
    await deleteMail(chatId);
  } else if (text === "❓ Help" || text === "Help") {
    await showHelp(chatId);
  } else if (/^\d+$/.test(text)) {
    await readEmail(chatId, parseInt(text) - 1);
  } else {
    await bot.sendMessage(chatId, "💡 Use the buttons below.", {
      reply_markup: mainKeyboard(),
    });
  }
});

console.log("🤖 Temp Mail Bot is running...");
module.exports = bot;