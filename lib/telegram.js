const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
export const sent = []; // для тестов

async function call(method, body) {
  if (process.env.MEMORY_DB) { sent.push({ method, ...body }); return { ok: true, result: {} }; }
  const r = await fetch(`${API()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export function reply(msg, text, extra = {}) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  return Promise.all(chunks.map(t => call('sendMessage', {
    chat_id: msg.chat.id,
    message_thread_id: msg.is_topic_message ? msg.message_thread_id : undefined,
    reply_to_message_id: msg.message_id,
    allow_sending_without_reply: true,
    text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  })));
}

export async function sendFile(msg, filename, content, caption) {
  if (process.env.MEMORY_DB) { sent.push({ method: 'sendDocument', filename, caption, content }); return; }
  const fd = new FormData();
  fd.append('chat_id', String(msg.chat.id));
  if (msg.is_topic_message) fd.append('message_thread_id', String(msg.message_thread_id));
  if (caption) fd.append('caption', caption);
  fd.append('document', new Blob(['﻿' + content], { type: 'text/csv' }), filename);
  await fetch(`${API()}/sendDocument`, { method: 'POST', body: fd });
}

export async function downloadFile(fileId) {
  const j = await call('getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${j.result.file_path}`);
  return Buffer.from(await r.arrayBuffer());
}

export const tg = call;
export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
