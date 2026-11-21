import { handleUpdate } from '../lib/bot.js';
import { redis } from '../lib/redis.js';
let hostSaved = false;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Bar bot is running');
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(401).send('bad secret');
  if (!hostSaved && req.headers.host) { hostSaved = true; redis('SET', 'host', req.headers.host).catch(() => {}); }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    await handleUpdate(body);
  } catch (e) { console.error(e); }
  res.status(200).json({ ok: true }); // всегда 200, иначе Telegram будет слать повторно
}
