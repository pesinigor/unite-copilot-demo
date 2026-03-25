// Unite AI Copilot — Telegram Bot
// Webhook: https://unitechat11.netlify.app/.netlify/functions/telegram
//
// Setup:
//  1. Get a bot token from @BotFather on Telegram
//  2. Add TELEGRAM_BOT_TOKEN to Netlify environment variables
//  3. After deploy, register the webhook once:
//     https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://unitechat11.netlify.app/.netlify/functions/telegram

const SYSTEM_PROMPT = `You are Unite AI Copilot — a smart, friendly assistant helping Igor manage his corporate holding structure through a Telegram chat. You know his business inside-out and respond like a real, knowledgeable colleague — not like a formal AI chatbot.

CLIENT CONTEXT — LTVentures Holdings (Igor's group):
Entities:
• LTVentures Holdings Ltd — BVI holding company, incorporated Jan 2021, Reg Agent: Maples Group
• LTVentures Singapore Pte Ltd — SEA operating HQ, UEN 202112345K, 2 directors
• LTVentures Delaware LLC — US operations, Reg No 7823459, EIN 87-1234567
• LTVentures UK Ltd — European operations, Co No 14789123, 2 directors

Upcoming deadlines (as of March 2026):
🔴 Apr 15 — US Federal Tax Return (Form 1065) — LTVentures Delaware — URGENT
🔴 Apr 30 — Annual Return ACRA — LTVentures Singapore — URGENT
🔴 Apr 30 — GST Q1 Filing — LTVentures Singapore — URGENT
🟡 May 31 — BVI Annual Return — LTVentures Holdings
🟡 Jun 1 — Delaware Annual Report
🟢 Oct 14 — Confirmation Statement — LTVentures UK

Banking & treasury:
• DBS Singapore — SGD account •8842 — $836K
• JPMorgan Chase — USD account — $501K
• Barclays UK — GBP account — $313K
• Total across entities: $1,650,000 USD

Pending actions:
• Invoice from Acme Corp Inc — $25,000 due Apr 5, 2026 (Delaware entity)
• Signature required: SG director resolution for Q1 dividend
• Q1 Dividend Resolution SG & BVI — signed Mar 12 ✓

HOW TO RESPOND:
- Respond like a smart human assistant texting on Telegram — NOT a formal AI
- Keep messages SHORT. Use line breaks, not walls of text
- Use emojis where they add meaning (🔴🟡🟢✅ for status, not decoratively)
- Be direct and specific — you know Igor's exact entities, deadlines, and balances
- If something is urgent, say so plainly and tell him what to do
- Split complex answers into 2–3 short messages worth of text max
- Don't say "As an AI..." or add disclaimers — just be helpful
- Don't repeat "Hi Igor" every message — just answer naturally`;

// In-memory conversation history per Telegram chat ID.
// Resets on function cold start — fine for a demo.
const histories = {};

exports.handler = async (event) => {
  // Health check
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Unite Telegram Bot is running.' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'OK' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: 'OK' }; }

  const msg = body.message || body.edited_message;
  if (!msg) return { statusCode: 200, body: 'OK' };

  const chatId      = String(msg.chat.id);
  const isGroup     = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const botUsername = process.env.TELEGRAM_BOT_USERNAME || '';

  // Files (documents, photos, etc.) carry text in msg.caption, not msg.text
  const hasFile = !!(msg.document || msg.photo || msg.audio || msg.video || msg.voice);
  const rawText = msg.text || msg.caption || '';
  if (!rawText && !hasFile) return { statusCode: 200, body: 'OK' };

  // Strip @BotName suffix from commands in groups (e.g. /start@BotName → /start)
  let userText = rawText.trim();
  // If a file was sent, append a note so Claude knows
  if (hasFile) {
    const fileType = msg.document ? 'document/PDF' : msg.photo ? 'photo' : msg.audio ? 'audio' : 'file';
    userText = userText
      ? `${userText} [User also attached a ${fileType} — you cannot read its contents, but acknowledge it and respond to their request]`
      : `[User sent a ${fileType} with no caption — acknowledge you received it but explain you can't read file contents yet]`;
  }
  if (botUsername) {
    userText = userText.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
  }


  // /start command
  if (userText.startsWith('/start')) {
    await sendTelegram(chatId, `Hey! I'm your Unite AI Copilot 👋\n\nI know your entities, deadlines, and banking across LTVentures. Just ask me anything — "what's due this month?", "how much cash do we have?", "draft a reminder for the Delaware filing".\n\nWhat do you need?`);
    return { statusCode: 200, body: 'OK' };
  }

  // /clear command — reset history
  if (userText.startsWith('/clear')) {
    histories[chatId] = [];
    await sendTelegram(chatId, 'Fresh start ✅');
    return { statusCode: 200, body: 'OK' };
  }

  // Build / trim history (keep last 16 messages = 8 turns)
  if (!histories[chatId]) histories[chatId] = [];
  const history = histories[chatId];
  history.push({ role: 'user', content: userText });
  if (history.length > 16) history.splice(0, 2);

  // Show typing indicator
  await sendTyping(chatId);

  // Call Claude
  let reply;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: history,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Claude API error:', err);
      reply = "Sorry, something went wrong on my end. Try again in a sec.";
    } else {
      const data = await response.json();
      reply = data.content?.[0]?.text || "Hmm, I didn't get a response. Try again?";
    }
  } catch (err) {
    console.error('Fetch error:', err);
    reply = "Connection issue — try again in a moment.";
  }

  // Save assistant reply to history
  history.push({ role: 'assistant', content: reply });

  // Send reply
  await sendTelegram(chatId, reply);

  return { statusCode: 200, body: 'OK' };
};

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error('TELEGRAM_BOT_TOKEN not set'); return; }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      // Disable web page previews for cleaner messages
      disable_web_page_preview: true,
    }),
  }).catch(err => console.error('Telegram send error:', err));
}

async function sendTyping(chatId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}
