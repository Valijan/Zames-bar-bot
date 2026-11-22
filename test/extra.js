import { handleUpdate, dailyReport } from '../lib/bot.js';
import { sent } from '../lib/telegram.js';
import { products, dprods } from '../lib/store.js';
import { redis } from '../lib/redis.js';
import { exportCSV } from '../lib/extra.js';

process.env.QUIET = '0';
let id = 1;
const G = { id: -100, type: 'supergroup' }, P = { id: 7, type: 'private' };
const send = async (text, chat = G, topic) => {
  const before = sent.length;
  await handleUpdate({ message: { message_id: id++, chat, from: { id: 7, first_name: 'Валижон' }, text,
    ...(topic ? { is_topic_message: true, message_thread_id: topic.length, reply_to_message: { forum_topic_created: { name: topic } } } : {}) } });
  return sent.slice(before).map(x => x.text || x.filename || '').join('\n---\n');
};
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exitCode = 1; } else console.log('✔', m); };
await send('/start', P);

// 3. цены поставщиков + 1. сигнал о подорожании
let o = await send('Приход Макро\nМолоко 10 л 120000\nЛимон 2 кг 30000');
ok(/Макро/.test(o), 'поставщик из первой строки прихода');
const before = sent.length;
o = await send('Приход Корзинка\nМолоко 10 л 150000');
const dm = sent.slice(before).filter(x => x.chat_id === 7).map(x => x.text).join('\n');
ok(/Изменились цены закупки/.test(dm) && /Молоко/.test(dm) && /\+25%/.test(dm), 'владельцу пришёл сигнал о подорожании молока (+25%)');
ok(/Капучино/.test(dm), 'в сигнале — какие позиции подорожали');
o = await send('/prices молоко', P);
ok(/Дешевле всего сейчас: <b>Макро<\/b>/.test(o), '/prices: где дешевле');
o = await send('/prices', P);
ok(/Лимон/.test(o) && /Макро/.test(o), '/prices: список лучших цен');

// 6. склады цехов
o = await send('Перемещение на кухню\nМолоко 3 л');
let dp = await dprods();
ok(dp['Кухня|Молоко']?.stock === 3000, 'перемещение пополнило склад кухни');
o = await send('Списание кухня\nМолоко 0,5 л');
dp = await dprods();
ok(dp['Кухня|Молоко']?.stock === 2500 && /склад Кухня/.test(o), 'списание со склада кухни');
const barMilk = (await products())['Молоко'].stock;
ok(barMilk === 17000, 'склад бара не тронут списанием кухни');
o = await send('Инвентаризация кухня\nМолоко 2 л');
ok(/факт 2 л/.test(o) && /недостача/.test(o), 'инвентаризация кухни');
o = await send('/undo да');
dp = await dprods();
ok(dp['Кухня|Молоко']?.stock === 2500, 'undo инвентаризации цеха');
o = await send('/dept кухня', P);
ok(/получено с бара/.test(o) && /Молоко: 2.5 л/.test(o), '/dept: отчёт и остаток кухни');

// продажи с выручкой цехов
o = await send('/sales 21.11\n157 20 900000\n178 30 1500000', P);
o = await send('/done', P);
ok(/внесены/.test(o), 'продажи внесены');

// 2. закупка
o = await send('/order', P);
ok(/Закупка на 7 дней/.test(o) && /Молоко/.test(o), '/order: список закупки');

// 4. калькулятор
o = await send('/calc Mont Blanc 30%\nКофе молотый 18 г\nМолоко 150 мл\nСироп ваниль 20 мл\nКаштановое пюре 30 г', P);
ok(/Mont Blanc/.test(o) && /👉 фудкост 30%/.test(o) && /Каштановое пюре/.test(o), '/calc: цена под фудкост + неизвестный ингредиент');

// 5. смены
o = await send('/shift Валижон, Камрон');
ok(/Валижон, Камрон/.test(o), '/shift');
o = await send('/shifts', P);
ok(/По людям/.test(o) && /Валижон/.test(o), '/shifts: по людям');

// 7. таблица
o = await send('/sheet', P);
const tok = await redis('GET', 'export_token');
ok(tok && o.includes(`t=${tok}&kind=stock`) && /IMPORTDATA/.test(o), '/sheet: формулы IMPORTDATA');
const csv = await exportCSV('stock', '2026-11-01', '2026-11-30');
ok(/^Склад,Продукт/.test(csv) && /Кухня,Молоко/.test(csv), 'CSV остатков с цехами');
const csv2 = await exportCSV('ops', '2026-11-01', '2026-12-31');
ok(/Приход/.test(csv2) && /Перемещение/.test(csv2), 'CSV движений');

// 1. утренний отчёт: «скоро закончится»
o = await send('Списание\nЛимон 1,9 кг');
const b2 = sent.length;
await dailyReport();
const morning = sent.slice(b2).map(x => x.text || x.filename || '').join('\n');
ok(/Скоро закончится/.test(morning) || /отчёт|Отчёт/.test(morning), 'утренний отчёт отработал');

// четверг
const { thursdayReminder } = await import('../lib/extra.js');
const fake = { chat: { id: 7, type: 'private' }, from: { id: 7 } };
let b3 = sent.length; await thursdayReminder(fake, 'morning');
let th = sent.slice(b3).map(x => x.text).join('\n');
ok(/ЧЕТВЕРГ|СЕГОДНЯ ЧЕТВЕРГ/.test(th) && /Закупка на 7 дней/.test(th), 'четверг: напоминание + список заказа');
o = await send('/supplier', P);
ok(/Coca-Cola/.test(o) && /Чорток/.test(o), '/supplier: кола и Чорток по умолчанию');
o = await send('/supplier Нестле: Сливки 10%, Молоко', P);
ok(/Нестле: Сливки 10%, Молоко/.test(o), '/supplier: привязка');
b3 = sent.length; const r = await thursdayReminder(fake, 'last');
ok(r === 'ok, заказы внесены', 'четверг 15:00: молчит, если приход с поставщиком был');

// списание, которое на самом деле перемещение
o = await send('Молоко 1 л\nСливки 10% 1 л на кухню\nЛимон 300 г отдал в пиццерию', G, 'Списание');
ok(/🔁/.test(o) && /Перемещение → Кухня/.test(o) && /Перемещение → Пиццерия/.test(o) && /Списание/.test(o), 'списание: строки «на кухню / в пиццерию» стали перемещениями');
o = await send('Списание на кухню\nМолоко 1 л', G);
ok(/Перемещение → Кухня/.test(o), 'заголовок «Списание на кухню» → перемещение');
o = await send('Списание кухня\nМолоко 0,2 л', G);
ok(/склад Кухня/.test(o) && !/🔁/.test(o), '«Списание кухня» без предлога — списание со склада кухни');

// импорт пересылкой
const fwd = async (text, ts) => { const b = sent.length; await handleUpdate({ message: { message_id: id++, chat: P, from: { id: 7 }, text, forward_origin: { type: 'user', date: ts } } }); return sent.slice(b); };
await send('/import списание', P);
const t1 = Math.floor(new Date('2026-11-16T10:00:00+05:00') / 1000), t2 = Math.floor(new Date('2026-11-18T10:00:00+05:00') / 1000);
let r1 = await fwd('Молоко 1 л\nЛимон 200 г на кухню', t1);
ok(r1.every(x => x.method === 'setMessageReaction'), 'импорт: на пересланное — только реакция');
await fwd('Молоко 1 л\nЛимон 200 г на кухню', t1);
await send('/import перемещение пиццерия', P);
await fwd('Сливки 10% 0,5 л', t2);
o = await send('/import готово', P);
ok(/Импорт завершён<\/b>: 2 сообщений за 16.11–18.11/.test(o) && /перенёс в перемещения: 1/.test(o) && /Повторы пропущены: 1/.test(o) && /Отчёт бара 16.11–18.11/.test(o), 'импорт: итог + отчёт за период, повтор не задвоился');
