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
// Список доступных моделей, лучшие первыми (свежие flash без preview → lite → остальные)
export async function listModels(key) {
  if (process.env.GEMINI_MODEL) return [process.env.GEMINI_MODEL];
  let j = await (await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } })).json();
  if (j.error) j = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`)).json();
  if (j.error) throw new Error(j.error.message);
  const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => /gemini/.test(n) && !/(tts|audio|image|embedding|live|thinking-exp|imagen|robotics|computer-use)/.test(n));
  const score = n => (/flash/.test(n) ? 1000 : 0) - (/lite/.test(n) ? 200 : 0) - (/(preview|exp)/.test(n) ? 400 : 0) + (parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0) * 10);
  ok.sort((x, y) => score(y) - score(x));
  if (!ok.length) throw new Error('нет доступных моделей Gemini для этого ключа');
  return ok;
}
export const pickModel = async key => (await listModels(key))[0];

// Временная проблема модели (перегрузка, лимит, модель убрали) — пробуем следующую
const temporary = e => /high demand|overload|unavailable|try again|quota|rate|exhausted|not found|not supported|deprecated|limit/i.test(e.message || '') || [429, 500, 503, 404].includes(e.code);

// Проверка ключа: ключ рабочий, если Google отдал список моделей. Затем ищем модель, которая отвечает.
export async function testGemini(key) {
  let models;
  try { models = await listModels(key); } catch (e) { return { error: e.message }; }
  let last;
  for (const model of models.slice(0, 8)) {
    const j = await gen(key, model, { contents: [{ parts: [{ text: 'Ответь одним словом: ок' }] }] });
    if (!j.error) return { model };
    last = `${j.error.message} (модель ${model})`;
    if (!temporary(j.error)) return { error: last };
  }
  return { model: models[0], warn: last }; // все заняты — ключ всё равно сохраняем
}
// Ключ передаём заголовком x-goog-api-key (так работают и старые AIza…, и новые AQ.…); при отказе — параметром ?key=
async function gen(key, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const opt = h => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
  let j = await (await fetch(url, opt({ 'x-goog-api-key': key }))).json();
  if (j.error && j.error.code === 401) j = await (await fetch(`${url}?key=${encodeURIComponent(key)}`, opt({}))).json();
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gemini(prompt, buf, mime) {
  const key = await geminiKey();
  if (!key) throw new Error('NO_GEMINI_KEY');
  const saved = process.env.GEMINI_MODEL || (await redis('GET', 'gemini_model'));
  let models = [];
  try { models = await listModels(key); } catch (e) { if (!saved) throw e; }
  const order = [...new Set([saved, ...models].filter(Boolean))].slice(0, 6);
  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };
  let lastErr;
  for (let round = 0; round < 2; round++) {
    for (const model of order) {
      const j = await gen(key, model, body);
      if (!j.error) {
        if (model !== saved) await redis('SET', 'gemini_model', model);
        const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
        return JSON.parse(txt.replace(/^```json|```$/g, ''));
      }
      lastErr = j.error;
      if (!temporary(j.error)) throw new Error('Gemini: ' + j.error.message);
    }
    await sleep(4000); // все заняты — подождать и попробовать ещё раз
  }
  throw new Error('Gemini сейчас перегружен, попробуйте прислать фото через пару минут (' + (lastErr?.message || '') + ')');
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
