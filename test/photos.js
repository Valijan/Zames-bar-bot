import { handleUpdate, dailyReport } from '../lib/bot.js';
import { sent } from '../lib/telegram.js';
import { opsBetween } from '../lib/store.js';
import { redis } from '../lib/redis.js';
process.env.GEMINI_API_KEY = 'x';
const ok = (c, m) => { if (!c) { console.error('❌', m); process.exitCode = 1; } else console.log('✔', m); };
let mode = 'ok';
const pages = [
  { kind: 'sales', from: '21.11.2026', to: '21.11.2026', rows: [{ section: 'Бар', code: '178', name: 'АССАМ', qty: 32, sum: 1590000 }, { section: 'Бар', code: '157', name: 'КАПУЧИНО', qty: 16, sum: 720000 }] },
  { kind: 'sales', rows: [{ section: 'Бар', code: '212', name: 'КОЛА', qty: 12, sum: 300000 }, { section: 'Кондитерская', code: '861', name: 'ЗАВАРНОЕ', qty: 27, sum: 1620000 }], totals: { 'Бар': 2610000, 'Кондитерская': 1620000 } },
];
let call = 0;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('/models?')) return { json: async () => ({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] }] }) };
  if (url.includes('generativelanguage')) {
    if (mode === 'busy') return { json: async () => ({ error: { code: 503, message: 'high demand' } }) };
    const pg = JSON.parse(o.body).contents[0].parts[1].inline_data.data === Buffer.from('p1').toString('base64') ? pages[0] : pages[1];
    await new Promise(r => setTimeout(r, 30));
    return { json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(pg) }] } }] }) };
  }
  // скачивание фото из Telegram: отдаём «p1» / «p2»
  return { arrayBuffer: async () => Uint8Array.from(Buffer.from('p1')).buffer };
};
const P = { id: 7, type: 'private' };
await handleUpdate({ message: { message_id: 1, chat: P, from: { id: 7 }, text: '/start' } });
const tgMod = await import('../lib/telegram.js');
// подменяем getFile, чтобы путь файла отличался
const photo = (mid, f) => ({ message: { message_id: mid, chat: P, from: { id: 7 }, photo: [{ file_id: f, file_unique_id: f }] } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => String(u).includes('api.telegram.org/file') ? realFetch(String(u).endsWith('undefined') ? 'x' : u, o) : realFetch(u, o);
// в MEMORY режиме getFile возвращает result:{} → путь undefined; различаем фото через file_id в sent? проще: два последовательных вызова
let n = 0;
globalThis.fetch = async (u, o) => { if (String(u).includes('api.telegram.org/file')) { const k = ++n; return { arrayBuffer: async () => Uint8Array.from(Buffer.from(k === 1 ? 'p1' : 'p2')).buffer }; } return realFetch(u, o); };
const b = sent.length;
await Promise.all([handleUpdate(photo(10, 'a1')), handleUpdate(photo(11, 'a2'))]); // альбом — одновременно
const ops = (await opsBetween('2026-11-21', '2026-11-21')).filter(o => o.type === 'sales');
ok(ops.length === 1 && ops[0].revenue === 2610000, 'альбом из 2 фото: продажи внесены автоматически (сошлось с «Итого Бар»)');
ok(ops[0].deptRevenue?.['Кондитерская'] === 1620000, 'выручка кондитерской сохранена');
const txt = sent.slice(b).map(x => x.text || '').join('\n');
ok(/Отчёт бара за 21\.11/.test(txt) && /Топ продаж/.test(txt), 'сразу пришёл отчёт за день');
// повтор того же фото (Telegram retry) не задваивает
await handleUpdate(photo(10, 'a1'));
ok((await opsBetween('2026-11-21', '2026-11-21')).filter(o => o.type === 'sales').length === 1, 'повтор фото не задвоил продажи');
// перегрузка Google — понятное сообщение
mode = 'busy'; const b2 = sent.length;
await handleUpdate(photo(20, 'b1'));
ok(/перегружен.*ещё раз/s.test(sent.slice(b2).map(x => x.text || '').join('\n')), 'Google перегружен: понятная подсказка прислать позже');
mode = 'ok';
// /day и утренний отчёт
const b3 = sent.length;
await handleUpdate({ message: { message_id: 30, chat: P, from: { id: 7 }, text: '/day 21.11' } });
ok(/Выручка: <b>2 610 000/.test(sent.slice(b3).map(x => x.text || '').join('\n')), '/day 21.11');
const b4 = sent.length; await dailyReport();
const mtxt = sent.slice(b4).map(x => x.text || '').join('\n');
ok(/Отчёт бара за \d\d\.\d\d/.test(mtxt) && (/Выручка/.test(mtxt) || /нет — пришлите фото/.test(mtxt)), 'утро: отчёт за вчера (или напоминание прислать фото)');
