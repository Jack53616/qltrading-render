// bot.js — QL Trading AI Telegram Bot
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// 🧠 أوامر أساسية
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || "صديقي";
  await bot.sendMessage(
    chatId,
    `👋 أهلاً ${firstName}!\nمرحباً بك في QL Trading AI 💎\n\n` +
    `🔐 استخدم مفتاح الاشتراك الخاص بك للدخول إلى المنصة.`
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🧭 أوامر المساعدة:\n` +
    `/start - بدء المحادثة\n` +
    `/help - عرض قائمة الأوامر\n` +
    `/status - التحقق من حالة النظام`
  );
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `📊 النظام يعمل بشكل ممتاز ✅`);
});

// أي رسالة غير الأوامر
bot.on("message", async (msg) => {
  const text = msg.text || "";
  if (!text.startsWith("/")) {
    await bot.sendMessage(msg.chat.id, "💬 استخدم /help لمعرفة الأوامر المتاحة.");
  }
});

export default bot;
