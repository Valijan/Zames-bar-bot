import { redis } from '../lib/redis.js';
import { exportCSV } from '../lib/extra.js';
import { today } from '../lib/store.js';
// CSV для Google Таблиц: =IMPORTDATA("https://.../api/export?t=ТОКЕН&kind=stock|sales|ops|prices")
export default async function handler(req, res) {
  const q = new URL(req.url, 'http://x').searchParams;
  const t = await redis('GET', 'export_token');
  if (!t || q.get('t') !== t) return res.status(403).send('forbidden');
  const kind = ['stock', 'sales', 'ops', 'prices'].includes(q.get('kind')) ? q.get('kind') : 'stock';
  const to = q.get('to') || today();
  const from = q.get('from') || to.slice(0, 8) + '01';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(await exportCSV(kind, from, to));
}
