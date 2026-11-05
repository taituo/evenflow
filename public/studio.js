// Full-screen studio shell: the studio canvas with no spreadsheet chrome around it (for a big monitor).
// /studio opens the first studio canvas (creating one if there is none); /studio#<doc id> opens that one.
import { applyDocOp, replaceInPlace } from './shared/types/index.js';

const clientId = Math.random().toString(36).slice(2, 10);
const ME = (() => { try { return JSON.parse(localStorage.getItem('spread.user') || 'null') || { name: 'You', color: '#8f87ff' }; } catch { return { name: 'You', color: '#8f87ff' }; } })();
let doc = null, docId = null, view = null, pending = 0, dirty = false;

async function http(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data.error || data || r.statusText);
  return data;
}
const get = (u) => http('GET', u);
const post = (u, b) => http('POST', u, b);

const ctx = {
  clientId, me: ME, get, post,
  get doc() { return doc; },
  get docId() { return docId; },
  toast: (m, err) => (err ? console.error(m) : console.log(m)),
  submit(ops, label) {
    const inverse = [];
    try { for (const op of ops) inverse.unshift(...applyDocOp(doc, op).inverse); }
    catch (e) { console.error(e); reload(); return null; }
    pending++;
    post('/api/ops', { doc: docId, by: 'user', who: ME.name, color: ME.color, clientId, ops, label })
      .catch((e) => { console.error(e); dirty = true; })
      .finally(() => { pending--; if (!pending && dirty) reload(); });
    return inverse;
  },
};

async function reload() {
  dirty = false;
  const r = await get('/api/doc?id=' + encodeURIComponent(docId));
  replaceInPlace(doc, r.doc);
  view?.reload?.();
}

async function open() {
  const ws = await get('/api/workspace');
  const want = location.hash.slice(1);
  let d = ws.docs.find((x) => x.id === want && x.type === 'studio') || ws.docs.find((x) => x.type === 'studio');
  if (!d) { const r = await post('/api/docs', { type: 'studio', title: 'Studio', id: 'studio', by: 'user' }); d = { id: r.id }; }
  docId = d.id;
  doc = (await get('/api/doc?id=' + encodeURIComponent(docId))).doc;
  history.replaceState(null, '', '#' + docId);
  document.title = `${doc.title} · Studio`;
  const { mount } = await import('./canvases/studio/view.js');
  view = mount(document.getElementById('studio'), ctx);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'hello') { if (doc) reload(); return; }
    if (e.type === 'studio') return view?.studio?.(e);
    if (e.type === 'docs') { if (!e.docs.some((x) => x.id === docId)) location.reload(); return; }
    if (e.type !== 'batch' || e.doc !== docId || e.clientId === clientId) return;
    if (pending) { dirty = true; return; }
    try { for (const op of e.ops) applyDocOp(doc, op); } catch { reload(); return; }
    view?.remote?.(e);
  };
}

open().then(connect).catch((e) => { document.body.innerHTML = `<pre style="color:#f88;padding:20px">${String(e.message)}</pre>`; });
