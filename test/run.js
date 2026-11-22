import { handleUpdate } from '../lib/bot.js';
import { sent } from '../lib/telegram.js';
import { products } from '../lib/store.js';

process.env.QUIET = '0';
let id = 1;
const topicMsg = name => ({ message_id: 0, forum_topic_created: { name } });
const say = async (text, topic, extra = {}) => {
  const msg = { message_id: id++, chat: { id: -100, type: 'supergroup' }, from: { id: 7, first_name: 'Валижон' }, text,
    ...(topic ? { is_topic_message: true, message_thread_id: topic.length, reply_to_message: topicMsg(topic) } : {}), ...extra };
  const before = sent.length;
  await handleUpdate({ message: msg });
  const out = sent.slice(before).map(s => s.method === 'sendDocument' ? `[файл ${s.filename}]\n${s.content.split('\n').slice(0, 4).join('\n')}` : s.text).join('\n---\n');
  console.log(`\n>>> [${topic || 'общий'}] ${text}\n${out || '(молчит)'}`);
  return out;
};
const assert = (c, m) => { if (!c) { console.error('❌ FAIL:', m); process.exitCode = 1; } else console.log('✔', m); };

let o = await say('Привет всем, кто сегодня на смене?');
assert(o === '', 'обычная переписка — бот молчит');

o = await say('Молоко 12 л 144 000\nЛимон 5 кг 75000\nКола 48 шт 960 000\nКофе молотый 1 кг 280000\nАссам 1 кг 180 000\nКонцентрат ягодный 3 кг 270000\nСгущенка 2 банки 40000', 'Приход');
assert(/Молоко: \+12 л · 144 000/.test(o), 'приход молока по теме');
assert(/новый продукт «Сгущенка»/.test(o), 'новый продукт создаётся на приходе');

o = await say('Списание\nмолоко 1л прокисло', null);
assert(/Списание.*\n• Молоко: -1 л · 12 000/.test(o), 'списание по первому слову в общем чате');

o = await say('Перемещение в пиццерию\nЛимон 500 г\nмолако 2 л', null);
assert(/Пиццерия/.test(o) && /Молоко: -2 л/.test(o), 'перемещение в пиццерию, опечатка «молако»');

o = await say('Лимон 1 кг', 'Перемещение на кухню');
assert(/Кухня/.test(o) && /Лимон: -1 кг/.test(o), 'тема «Перемещение на кухню»');

o = await say('Кола 2', 'Списание');
assert(/Кола: -2 шт/.test(o), 'штучное без единицы');

o = await say('Банан 3 кг', 'Списание');
assert(/Не нашёл продукты: Банан/.test(o), 'неизвестный продукт на списании');

o = await say('/sales 20.11\n178 32 1590000\nКапучино 16 720000\n212 12 300000\n961 18 1440000\n999 1 5000', 'Продажи');
assert(/черновике 5 позиций/.test(o), 'продажи текстом в черновик');
o = await say('/done', 'Продажи');
assert(/Продажи 20.11–20.11<\/b> внесены/.test(o) && /Выручка бара: <b>4 055 000/.test(o), 'продажи внесены');
assert(/Фудкост/.test(o), 'фудкост посчитан');
assert(/Нет техкарты: 999/.test(o), 'позиция без техкарты');

o = await say('/sales 20.11\n178 1 50000', 'Продажи');
o = await say('/done', 'Продажи');
assert(/уже внесены/.test(o), 'защита от двойного внесения продаж');
await say('/cancel', 'Продажи');

o = await say('Молоко 3 л\nКола 30 шт', 'Инвентаризация');
assert(/Молоко: факт 3 л/.test(o) && /Кола: факт 30 шт \(недостача/.test(o), 'инвентаризация');

o = await say('/report 20.11-21.11');
assert(/Выручка бара: <b>4 055 000/.test(o) && /Пиццерия/.test(o) && /\[файл/.test(o), 'отчёт + CSV');

o = await say('/foodcost 20.11');
assert(/Ассам/.test(o), 'фудкост по позициям');

o = await say('/stock молоко');
assert(/Молоко: 3 л/.test(o), 'остатки');

o = await say('/tk ягодный');
assert(/Концентрат ягодный — 150 г/.test(o), 'техкарта');

o = await say('/alias сгущ = Сгущенка');
o = await say('Сгущ 1 шт', 'Списание');
assert(/Сгущенка: -1 шт/.test(o), 'алиас работает');
o = await say('/undo'); o = await say('/undo да');
assert(/Отменил: Списание/.test(o), 'undo');
const p = await products();
assert(p['Сгущенка'].stock === 2, 'undo вернул остаток');

o = await say('/price Сливки 10% 1 л 32000');
assert(/Сливки 10%: 32 000 сум за 1 л/.test(o), 'ручная цена');

// ---- тихий режим (как в группе по умолчанию) ----
process.env.QUIET = '1';
let b = sent.length;
await say('Молоко 1 л', 'Списание');
let last = sent.slice(b);
assert(last.length === 1 && last[0].method === 'setMessageReaction' && last[0].reaction[0].emoji === '👍', 'тихо: только реакция 👍');
b = sent.length;
await say('Ананасы 2 кг', 'Списание');
assert(sent.slice(b)[0].reaction?.[0].emoji === '🤔', 'тихо: непонятное — 🤔');
b = sent.length;
await say('/problems');
last = sent.slice(b);
assert(last.some(x => x.method === 'sendMessage' && x.chat_id === 7 && /Ананасы/.test(x.text)) && last.some(x => x.method === 'setMessageReaction'), '/problems уходит в личку');
b = sent.length;
await say('/report 21.11');
last = sent.slice(b);
assert(last.every(x => x.method === 'setMessageReaction' || x.chat_id === 7 || x.method === 'sendDocument') && !last.some(x => x.chat_id === -100 && x.method === 'sendMessage'), '/report: в группе ни слова, отчёт в личке');
await handleUpdate({ message: { message_id: 999, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/start' } });
const { dailyReport } = await import('../lib/bot.js');
assert(await dailyReport() === 'sent', 'утренний отчёт владельцу');

process.env.ALLOWED_CHATS = '-555';
o = await say('/stock');
assert(o === '', 'чужая группа игнорируется');
o = await say('/id');
assert(/-100/.test(o), '/id работает всегда');

// ---- месяц ----
delete process.env.ALLOWED_CHATS;
const before = sent.length;
await handleUpdate({ message: { message_id: 1000, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/month 11.2026' } });
const mo = sent.slice(before);
assert(mo.some(x => /Продажи бара за ноябрь 2026/.test(x.text || '')) && mo.some(x => x.method === 'sendDocument' && /prodazhi_bar_2026-11/.test(x.filename)), '/month: итог месяца + CSV в личку');
