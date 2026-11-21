// Распознавание фото отчёта iiko «Общие продажи блюд» через Gemini (есть бесплатный ключ).
const PROMPT = `Это фото отчёта iiko «Общие продажи блюд» (экран ноутбука, русский текст).
Верни ТОЛЬКО JSON такого вида:
{"from":"ДД.ММ.ГГГГ или null","to":"ДД.ММ.ГГГГ или null",
 "rows":[{"section":"Бар|Кондитерская|Кухня|...","code":"178","name":"АССАМ","qty":165,"sum":8140000}],
 "totals":{"Бар":44377000}}
Правила: code — число слева от названия; qty — число до "x" в колонке "К-во x Цена" (дробь через точку: "43,500" это 43.5);
sum — сумма справа без пробелов; section — заголовок группы, под которым стоит строка (если заголовка не видно на фото — "Бар").
Название может переноситься на вторую строку — склей. "Итого ..." строки клади в totals, не в rows. Ничего не выдумывай: не видно — не пиши.`;

const ITEMS_PROMPT = `На фото — накладная, чек, список продуктов или рукописная записка бара (приход / списание / перемещение).
Верни ТОЛЬКО JSON: {"date":"ДД.ММ.ГГГГ или null","dept":"Кухня|Пиццерия|Кондитерская|null",
"items":[{"name":"Молоко","qty":12,"unit":"л","sum":144000}]}
unit — одно из: кг, г, л, мл, шт (как написано; если не указано — null). sum — сумма за строку, если есть, иначе null.
Не выдумывай строк, которых нет на фото. Итоговые строки не включай.`;

import { redis } from './redis.js';
export async function geminiKey() { return process.env.GEMINI_API_KEY || (await redis('GET', 'gemini_key')) || null; }
// Выбрать доступную модель: спросить у Google список и взять свежую flash-модель с поддержкой картинок
export async function pickModel(key) {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => /gemini/.test(n) && !/(tts|audio|image-gen|embedding|live|thinking-exp|imagen)/.test(n));
  const score = n => (/flash/.test(n) ? 1000 : 0) - (/lite/.test(n) ? 300 : 0) - (/(preview|exp)/.test(n) ? 100 : 0) + (parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0) * 10);
  ok.sort((a, b) => score(b) - score(a));
  if (!ok.length) throw new Error('нет доступных моделей Gemini для этого ключа');
  return ok[0];
}
export async function testGemini(key) {
  try {
    const model = await pickModel(key);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'Ответь одним словом: ок' }] }] }) });
    const j = await r.json();
    if (j.error) return { error: `${j.error.message} (модель ${model})` };
    return { model };
  } catch (e) { return { error: e.message }; }
}
async function gemini(prompt, buf, mime) {
  const key = await geminiKey();
  if (!key) throw new Error('NO_GEMINI_KEY');
  let model = process.env.GEMINI_MODEL || (await redis('GET', 'gemini_model'));
  if (!model) { model = await pickModel(key); await redis('SET', 'gemini_model', model); }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  const j = await r.json();
  if (j.error) {
    if (/not found|not supported|deprecated/i.test(j.error.message)) await redis('DEL', 'gemini_model'); // в следующий раз выберем заново
    throw new Error('Gemini: ' + j.error.message);
  }
  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
  return JSON.parse(txt.replace(/^```json|```$/g, ''));
}
export const readItemsPhoto = (buf, mime = 'image/jpeg') => gemini(ITEMS_PROMPT, buf, mime);

export async function readSalesPhoto(buf, mime = 'image/jpeg') {
  return gemini(PROMPT, buf, mime);
}

const ANY_PROMPT = `Определи, что на фото, и верни ТОЛЬКО JSON.
1) Отчёт iiko о продажах («Общие продажи блюд», колонки «К-во x Цена», «Сумма»):
{"kind":"sales","from":"ДД.ММ.ГГГГ|null","to":"ДД.ММ.ГГГГ|null","rows":[{"section":"Бар","code":"178","name":"АССАМ","qty":165,"sum":8140000}],"totals":{"Бар":44377000}}
section — заголовок группы над строкой (нет заголовка на фото — "Бар"); qty — число до "x" ("43,500" = 43.5); строки "Итого" — только в totals.
2) Остатки / инвентаризация (отчёт «Остатки», список фактических остатков на складе):
{"kind":"stock","date":"ДД.ММ.ГГГГ|null","items":[{"name":"Молоко","qty":4,"unit":"л"}]}
3) Накладная, чек поставщика, список прихода/списания/перемещения:
{"kind":"items","type":"in|out|move|null","dept":"Кухня|Пиццерия|Кондитерская|null","date":"ДД.ММ.ГГГГ|null","items":[{"name":"Молоко","qty":12,"unit":"л","sum":144000}]}
unit — кг, г, л, мл или шт (не указано — null). Ничего не выдумывай.`;
export const readAnyPhoto = (buf, mime = 'image/jpeg') => gemini(ANY_PROMPT, buf, mime);
