// Один раз открыть в браузере: https://<проект>.vercel.app/api/setup?key=<SETUP_KEY>
import { TOKEN } from '../lib/telegram.js';
import { redis } from '../lib/redis.js';
import { listModels } from '../lib/vision.js';

export default async function handler(req, res) {
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (process.env.SETUP_KEY && key !== process.env.SETUP_KEY) return res.status(401).send('Нужен ?key=SETUP_KEY');
  if (!TOKEN()) return res.status(500).send('Нет токена бота: добавьте переменную TELEGRAM_BOT_TOKEN в Vercel → Settings → Environment Variables и сделайте Redeploy');
  let db = 'ok';
  try { await redis('PING'); } catch (e) { db = 'НЕТ БАЗЫ: ' + e.message + ' — подключите Storage → Upstash Redis и Redeploy'; }
  let gemini = 'нет ключа — отправьте ключ боту в личку';
  const gk = process.env.GEMINI_API_KEY || await redis('GET', 'gemini_key').catch(() => null);
  if (gk) { try { const ms = await listModels(gk); gemini = 'ok (' + ms[0] + ')'; } catch (e) { gemini = 'ошибка: ' + e.message; } }
  const api = `https://api.telegram.org/bot${TOKEN()}`;
  const post = (m, b) => fetch(`${api}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const hook = await post('setWebhook', {
    url: `https://${req.headers.host}/api/telegram`,
    secret_token: process.env.WEBHOOK_SECRET || undefined,
    allowed_updates: ['message'], drop_pending_updates: true,
  });
  const cmds = await post('setMyCommands', { commands: [
    ['month', 'Продажи за месяц'], ['order', 'Что заказать'], ['supplier', 'Фирмы и их продукты'], ['prices', 'Цены поставщиков'], ['calc', 'Цена новой позиции'], ['dept', 'Склады цехов'], ['shifts', 'Смены и недостачи'], ['shift', 'Кто на смене'], ['sheet', 'Google Таблица'], ['import', 'Загрузить старые сообщения'], ['stock', 'Остатки'], ['report', 'Отчёт: /report 16.11-20.11'], ['foodcost', 'Фудкост по позициям'],
    ['tk', 'Техкарта: /tk ассам'], ['done', 'Внести продажи из фото'], ['cancel', 'Сбросить черновик продаж'],
    ['price', 'Цена: /price Молоко 1 л 12000'], ['alias', 'Синоним продукта'], ['undo', 'Отменить мою последнюю операцию'],
    ['topic', 'Назначить тип теме'], ['id', 'id чата'], ['help', 'Как пользоваться'],
  ].map(([command, description]) => ({ command, description })) });
  // старый бот food cost: убрать кнопку Mini App и обновить описание
  await post('setChatMenuButton', { menu_button: { type: 'commands' } });
  await post('setMyDescription', { description: 'Учёт бара ZAMES: приход, списание, перемещения на кухню/в пиццерию/в кондитерскую, продажи по фото iiko, остатки и фудкост. Добавьте в рабочую группу и сделайте админом.' });
  await post('setMyShortDescription', { short_description: 'Учёт бара ZAMES: остатки, списания, фудкост' });
  const me = await post('getMe', {});
  await new Promise(r => setTimeout(r, 1500));
  const info = (await post('getWebhookInfo', {})).result || {};
  res.status(200).json({ tg_last_error: info.last_error_message || 'нет', tg_last_error_date: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null, tg_pending: info.pending_update_count, tg_url: info.url, bot: me.result?.username, webhook: hook.ok ? 'подключён' : hook, redis: db, gemini, commands: cmds.ok });
}
