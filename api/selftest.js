import { handleUpdate } from '../lib/bot.js';
import { redis } from '../lib/redis.js';
// Проверка: прогоняет /help как будто из лички владельца и возвращает ошибку, если код падает
export default async function handler(req, res) {
  const out = {};
  try { out.owner = await redis('GET', 'owner'); } catch (e) { out.redis = e.message; }
  try {
    await handleUpdate({ message: { message_id: 0, chat: { id: 0, type: 'private' }, from: { id: 0 }, text: '/id' } });
    out.handle = 'ok';
  } catch (e) { out.handle = e.stack?.slice(0, 500); }
  res.status(200).json(out);
}
