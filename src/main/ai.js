'use strict';
const config = require('./config');

function headers() {
  const { apiKey } = config.get().ai;
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}
function base() {
  return (config.get().ai.baseUrl || '').replace(/\/+$/, '');
}

async function chat(messages, { onChunk, signal } = {}) {
  const { model } = config.get().ai;
  const res = await fetch(`${base()}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    signal,
    body: JSON.stringify({ model, messages, stream: !!onChunk }),
  });
  if (!res.ok) throw new Error(`AI request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  if (!onChunk) {
    const j = await res.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }
  let full = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (delta) { full += delta; onChunk(delta); }
      } catch { /* partial line */ }
    }
  }
  return full;
}

async function summarize(text, locale) {
  const lang = locale === 'zh-Hant' ? 'Traditional Chinese (繁體中文)' : 'the same language as the transcript';
  const content = await chat([
    {
      role: 'system',
      content: 'You summarize voice transcripts. Reply ONLY with JSON: {"title": string, "summary": string}. '
        + `Title: at most 12 words. Summary: 2-5 sentences plus key bullet points if useful. Write in ${lang}.`,
    },
    { role: 'user', content: text.slice(0, 12000) },
  ]);
  try {
    const m = content.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : content);
    return { title: String(j.title || '').trim(), summary: String(j.summary || '').trim() };
  } catch {
    return { title: '', summary: content.trim() };
  }
}

async function test() {
  const res = await fetch(`${base()}/models`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const models = Array.isArray(j.data) ? j.data.map((m) => m.id) : [];
  return { ok: true, models };
}

module.exports = { chat, summarize, test };
