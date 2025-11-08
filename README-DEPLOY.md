# QL Trading AI — Render Webhook Deploy (Logs Enabled)
Updated: 2025-11-08T21:02:20.179163Z

## Environment variables (Render → Service → Environment)
- BOT_TOKEN = <your bot token>
- DATABASE_URL = <postgres url>
- WEBHOOK_URL = https://<your-service>.onrender.com
- JWT_SECRET = ql_secret_2025
- PGSSLMODE = true

## Start command (Render)
- Web Service: `npm run start`

## Expected Logs
- "🟢 Starting QL Trading AI Server..." on boot
- "✅ Setting Telegram webhook to ..." when webhook set
- "📩 Webhook request received from Telegram" on incoming updates
- "🔑 Activation request: ..." when /api/activate is called
- "🧩 New key created: ..." when /create_key is used

## Webhook manual set (optional)
GET https://api.telegram.org/bot<token>/setWebhook?url=https://<your-service>.onrender.com/webhook/<token>
GET https://api.telegram.org/bot<token>/getWebhookInfo

