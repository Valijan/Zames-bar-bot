// Разбор свободного текста из тем группы.

export const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9%]+/g, ' ').trim();

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
  let s = line.replace(/^[\s\-–•*\d]+[.)]\s+/, '').trim(); // убрать "1. " / "- "
  if (!s) return null;
  // цена в конце: "... 120 000" или "... 120000 сум" или "... цена 120000"
  let price = null;
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
    else if (price !== null && price < 100000 && !pm[1].includes(' ')) { // "Кола 24" попало в цену
      qty = price; price = null; name = body;
    }
  }
  name = name.replace(/[:\-–—=,]+$/, '').replace(/^[:\-–—]+/, '').trim();
  if (!name || qty === null || isNaN(qty)) return null;
  return { name, qty, unit, price };
}

export function parseItems(text, skipHeader) {
  const lines = text.split('\n');
  const out = [], bad = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    if (i === 0 && skipHeader) {
      // заголовок может быть и строкой с товаром: "Списание: молоко 1 л"
      const rest = l.replace(/^[^:]*:/, '');
      if (rest !== l && rest.trim()) { const p = parseLine(rest); if (p) { p.line = l; out.push(p); } }
      return;
    }
    const p = parseLine(l);
    if (p) { p.line = l; out.push(p); } else bad.push(l.trim());
  });
  return { items: out, bad };
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
