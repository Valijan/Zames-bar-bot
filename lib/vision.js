// Распознавание фото отчёта iiko «Общие продажи блюд» через Gemini (есть бесплатный ключ).
const PROMPT = `Это фото отчёта iiko «Общие продажи блюд» (экран ноутбука, русский текст).
Верни ТОЛЬКО JSON такого вида:
{"from":"ДД.ММ.ГГГГ или null","to":"ДД.ММ.ГГГГ или null",
 "rows":[{"section":"Бар|Кондитерская|Кухня|...","code":"178","name":"АССАМ","qty":165,"sum":8140000}],
 "totals":{"Бар":44377000}}
Правила: code — число слева от названия; qty — число до "x" в колонке "К-во x Цена" (дробь через точку: "43,500" это 43.5);
sum — сумма справа без пробелов; section — заголовок группы, под которым стоит строка (если заголовка не видно на фото — "Бар").
Название может переноситься на вторую строку — склей. "Итого ..." строки клади в totals, не в rows. Ничего не выдумывай: не видно — не пиши.`;

export async function readSalesPhoto(buf, mime = 'image/jpeg') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Не задан GEMINI_API_KEY — без него бот не читает фото. Можно прислать продажи текстом (/sales).');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: buf.toString('base64') } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error('Gemini: ' + j.error.message);
  const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '{}';
  return JSON.parse(txt.replace(/^```json|```$/g, ''));
}
