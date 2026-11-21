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

async function gemini(prompt, buf, mime) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('NO_GEMINI_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error('Gemini: ' + j.error.message);
  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
  return JSON.parse(txt.replace(/^```json|```$/g, ''));
}
export const readItemsPhoto = (buf, mime = 'image/jpeg') => gemini(ITEMS_PROMPT, buf, mime);

export async function readSalesPhoto(buf, mime = 'image/jpeg') {
  return gemini(PROMPT, buf, mime);
}
