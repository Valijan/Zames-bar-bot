// Один раз открыть в браузере: https://<проект>.vercel.app/api/setup?key=<SETUP_KEY>
import { TOKEN } from '../lib/telegram.js';
import { redis } from '../lib/redis.js';

export default async function handler(req, res) {
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (process.env.SETUP_KEY && key !== process.env.SETUP_KEY) return res.status(401).send('Нужен ?key=SETUP_KEY');
  if (!TOKEN()) return res.status(500).send('Нет токена бота: добавьте переменную TELEGRAM_BOT_TOKEN в Vercel → Settings → Environment Variables и сделайте Redeploy');
  let db = 'ok';
  try { await redis('PING'); } catch (e) { db = 'НЕТ БАЗЫ: ' + e.message + ' — подключите Storage → Upstash Redis и Redeploy'; }
  let gemini = 'нет GEMINI_API_KEY';
  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Ответь одним словом: ок' }] }] }) });
      const j = await r.json();
      gemini = j.error ? 'ошибка: ' + j.error.message : 'ok';
    } catch (e) { gemini = 'ошибка: ' + e.message; }
  }
  const api = `https://api.telegram.org/bot${TOKEN()}`;
  const post = (m, b) => fetch(`${api}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const hook = await post('setWebhook', {
    url: `https://${req.headers.host}/api/telegram`,
    secret_token: process.env.WEBHOOK_SECRET || undefined,
    allowed_updates: ['message'], drop_pending_updates: true,
  });
  const cmds = await post('setMyCommands', { commands: [
    ['month', 'Продажи за месяц'], ['stock', 'Остатки'], ['report', 'Отчёт: /report 16.11-20.11'], ['foodcost', 'Фудкост по позициям'],
    ['tk', 'Техкарта: /tk ассам'], ['done', 'Внести продажи из фото'], ['cancel', 'Сбросить черновик продаж'],
    ['price', 'Цена: /price Молоко 1 л 12000'], ['alias', 'Синоним продукта'], ['undo', 'Отменить мою последнюю операцию'],
    ['topic', 'Назначить тип теме'], ['id', 'id чата'], ['help', 'Как пользоваться'],
  ].map(([command, description]) => ({ command, description })) });
  // старый бот food cost: убрать кнопку Mini App и обновить описание
  await post('setChatMenuButton', { menu_button: { type: 'commands' } });
  await post('setMyDescription', { description: 'Учёт бара ZAMES: приход, списание, перемещения на кухню/в пиццерию/в кондитерскую, продажи по фото iiko, остатки и фудкост. Добавьте в рабочую группу и сделайте админом.' });
  await post('setMyShortDescription', { short_description: 'Учёт бара ZAMES: остатки, списания, фудкост' });
  const me = await post('getMe', {});
  res.status(200).json({ bot: me.result?.username, webhook: hook.ok ? 'подключён' : hook, redis: db, gemini, commands: cmds.ok });
}
