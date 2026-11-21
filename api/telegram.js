import { handleUpdate } from '../lib/bot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Bar bot is running');
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).send('bad secret');
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await handleUpdate(body);
  } catch (e) { console.error(e); }
  res.status(200).json({ ok: true }); // всегда 200, иначе Telegram будет слать повторно
}
