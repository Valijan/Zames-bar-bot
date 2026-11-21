// Разбор свободного текста из тем группы.

export const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/без\s*-?\s*лактоз/g, 'безлактоз').replace(/[^a-zа-я0-9%]+/g, ' ').trim();

// единица -> [базовая, множитель]
const UNITS = {
  'кг': ['г', 1000], 'килограмм': ['г', 1000], 'kg': ['г', 1000],
  'г': ['г', 1], 'гр': ['г', 1], 'грамм': ['г', 1], 'g': ['г', 1],
  'л': ['мл', 1000], 'литр': ['мл', 1000], 'литра': ['мл', 1000], 'литров': ['мл', 1000], 'l': ['мл', 1000],
  'мл': ['мл', 1], 'ml': ['мл', 1],
  'шт': ['шт', 1], 'штук': ['шт', 1], 'штуки': ['шт', 1], 'бут': ['шт', 1], 'банка': ['шт', 1], 'банки': ['шт', 1], 'пачка': ['шт', 1], 'уп': ['шт', 1],
};
export const toBase = (q, unit) => (UNITS[unit] ? [q * UNITS[unit][1], UNITS[unit][0]] : [q, null]);

// Тип операции и цех по заголовку / первой строке
export function detectHeader(text) {
  const t = norm(text.split('\n')[0]);
  let type = null;
  if (/^(приход|поступлен|закуп|принял|приняли)/.test(t)) type = 'in';
  else if (/^(списан|спис|брак|испорч|бой)/.test(t)) type = 'out';
  else if (/^(перемещ|передал|передача|отдал|на кухн|в пиццер|в кондит)/.test(t)) type = 'move';
  else if (/^(инвент|ревиз|остатки факт|факт)/.test(t)) type = 'inv';
  else if (/^(продаж)/.test(t)) type = 'sales';
  return { type, dept: detectDept(text) };
}

export function detectDept(text) {
  const t = norm(text);
  if (/пицц/.test(t)) return 'Пиццерия';
  if (/кондит/.test(t)) return 'Кондитерская';
  if (/кухн/.test(t)) return 'Кухня';
  return null;
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
// количество с единицей: "2 кг", "2кг", "0,5л"
const QTY_UNIT = new RegExp(`(${NUM})\\s*(${UNIT_RE})\\.?(?=\\s|$|[,;])`, 'gi');

const toNum = s => parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));

// "Молоко 10 л 120 000" -> {name, qty, unit, price}
export function parseLine(line) {
  let s = line.replace(/^[\s\-–•*\d]+[.)]\s+/, '').replace(/\([^)]*\)/g, ' ').replace(/[<>]+|=>|->|→/g, ' ').replace(/\s+/g, ' ').trim(); // убрать "1. " / "- "
  if (!s) return null;
  // цена в конце: "... 120 000" или "... 120000 сум" или "... цена 120000"
  let price = null, perUnit = null;
  if (/(за|\/)\s*(1\s*)?(кг|литр|кило|л|шт)(?=\s|$|[.,;])/i.test(s)) { perUnit = true; s = s.replace(/(за|\/)\s*(1\s*)?(кг|литр|кило|л|шт)(?=\s|$|[.,;])/i, ' '); }
  else if (/(итого|всего|сумма|=)/i.test(s)) perUnit = false;
  const pm = s.match(/(?:=|цена|сумма|за)?\s*(\d{1,3}(?:[  ]\d{3})+|\d{4,})\s*(?:сум|sum|сўм)?\.?\s*$/i);
  let body = s;
  if (pm) { price = toNum(pm[1]); body = s.slice(0, pm.index).trim(); }

  let qty = null, unit = null, name = body;
  const all = [...body.matchAll(QTY_UNIT)];
  if (all.length) {
    const m = all[all.length - 1];
    qty = toNum(m[1]); unit = m[2].toLowerCase();
    name = (body.slice(0, m.index) + ' ' + body.slice(m.index + m[0].length)).trim();
  } else {
    const m = body.match(new RegExp(`(${NUM})\\s*$`));
    if (m) { qty = toNum(m[1]); name = body.slice(0, m.index).trim(); }
    else if (price !== null) { // «Кола 24», «Лайм 2 700» — это количество, а не сумма
      qty = price; price = null; name = body;
    }
  }
  name = name.replace(/[:\-–—=,]+$/, '').replace(/^[:\-–—]+/, '').trim();
  if (qty === null || isNaN(qty)) return null;
  return { name, qty, unit, price, perUnit };
}

// Разбор сообщения по строкам: дата в начале строки, цех («на кухню», «на пицца цех»), причина списания,
// строка без продукта («277 гр на кухню») берёт продукт из строки выше.
const DEPT_PHRASE = /(^|\s)(на|в|во|для)\s+(кухн\S*|пицц\S*(\s+цех\S*)?|цех\s+пицц\S*|кондит\S*)/i;
const GIVE_WORDS = /(^|\s)(отдал[аи]?|передал[аи]?|перемещ\S*)(?=\s|$)/gi;
const REASON = /(настройк\S*\s+помол\S*|помол\S*|брак\S*|проли\S*|разби\S*|испорт\S*|просроч\S*|дегустац\S*|на\s+пробу|для\s+фреш\S*)/i;
export function parseItems(text, skipHeader) {
  const lines = text.split('\n');
  const out = [], bad = [];
  let curDate = null, prevName = null;
  lines.forEach((raw, i) => {
    let l = raw;
    if (!l.trim()) return;
    if (i === 0 && skipHeader) {
      const rest = l.replace(/^[^:]*:/, '');
      if (rest === l || !rest.trim()) return;
      l = rest;
    }
    const dm = l.match(/^\s*(\d{1,2}\.\d{1,2}(?:\.\d{2,4})?)\s+/);
    if (dm) { curDate = dm[1]; l = l.slice(dm[0].length); }
    let moveDept = null;
    const dp = l.match(DEPT_PHRASE);
    if (dp) { moveDept = detectDept(dp[0]); l = l.replace(dp[0], ' '); }
    if (GIVE_WORDS.test(l)) { moveDept = moveDept || 'Кухня'; l = l.replace(GIVE_WORDS, ' '); }
    let reason = null;
    const note = (l.match(/\(([^)]*)\)/) || [])[1] || '';
    if (/>>>|=>|→/.test(l) || /фреш/i.test(note)) reason = /фреш/i.test(note + l) ? 'на фреш' : 'переработка';
    const rm = l.match(REASON);
    if (rm) { reason = rm[0].toLowerCase(); l = l.replace(rm[0], ' '); }
    if (note) l = l.replace(/\([^)]*\)/g, ' ');
    const p = parseLine(l);
    if (!p && !/[a-zа-я]/i.test(l) && /\d/.test(l) && prevName) { // только число без единицы
      const q = parseLine(prevName + ' ' + l); if (q) Object.assign(q, { name: prevName });
    }
    if (p && (!p.name || !/[a-zа-я]/i.test(p.name))) {
      if (reason && /помол/.test(reason)) p.name = 'Кофе молотый';
      else if (prevName) p.name = prevName;
    }
    if (p && reason && /помол/.test(reason) && /^кофе$/i.test(p.name.trim())) p.name = 'Кофе молотый';
    if (p && p.name && /[a-zа-я]/i.test(p.name)) {
      Object.assign(p, { line: raw, date: curDate, moveDept, reason });
      prevName = p.name;
      out.push(p);
    } else bad.push(raw.trim());
  });
  return { items: out, bad };
}

// Определить тип сообщения без темы (для импорта истории)
export function guessType(text) {
  const t = norm(text);
  if (/^(приход|поступлен|закуп)/.test(t)) return 'in';
  if (/^(списан|брак)/.test(t)) return 'out';
  if (/^(инвент|остатки)/.test(t)) return 'inv';
  if (DEPT_PHRASE.test(text) || /отдал|передал|перемещ/i.test(text)) return 'move';
  if (REASON.test(text) || />>>/.test(text)) return 'out';
  return 'in';
}

// дата "16.11" / "16.11.2026"
export function parseDate(s, year) {
  const m = String(s).match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
  if (!m) return null;
  let y = m[3] ? +m[3] : year; if (y < 100) y += 2000;
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

// «на кухню», «в пиццерию», «для кондитерской», «отдал/передал» — это перемещение, а не списание
export const MOVE_RE = /(^|\s)(на|в|во|для)\s+(кухн|пицц|кондит)|передал|передали|отдал|отдали|перемещ/i;
