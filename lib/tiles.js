// Map tiles from the National Land Survey of Finland (Maanmittauslaitos), through a small caching proxy:
// the API key stays on the server, and every tile is fetched from NLS once (they ask clients to buffer tiles).
//   GET /tiles/nls/<layer>/<z>/<x>/<y>     layer: ortokuva | maastokartta | taustakartta | selkokartta
// Key: env NLS_API_KEY or `cm config nls-key KEY` (free: https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-ohje).
// Data © Maanmittauslaitos, CC BY 4.0.
import fs from 'node:fs';
import path from 'node:path';

export const NLS_LAYERS = { ortokuva: 'jpg', maastokartta: 'png', taustakartta: 'png', selkokartta: 'png' };
const MAX_AGE = 7 * 864e5;
const inflight = new Map();

export function nlsBase() { return (process.env.NLS_TILE_BASE || 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0').replace(/\/$/, ''); }
export function nlsKey(store) { return process.env.NLS_API_KEY || store.settings().nlsKey || ''; }

/** Returns { body: Buffer, type } or throws { status, message }. */
export async function nlsTile(store, layer, z, x, y) {
  const ext = NLS_LAYERS[layer];
  if (!ext) throw Object.assign(new Error(`No NLS layer "${layer}" (${Object.keys(NLS_LAYERS).join(', ')})`), { status: 404 });
  [z, x, y] = [z, x, y].map((n) => +n);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 16 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw Object.assign(new Error('Bad tile'), { status: 400 });
  const type = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  const file = path.join(store.dir, 'tiles', 'nls', layer, String(z), String(x), `${y}.${ext}`);
  try { const st = fs.statSync(file); if (Date.now() - st.mtimeMs < MAX_AGE) return { body: fs.readFileSync(file), type, cached: true }; } catch {}
  const key = nlsKey(store);
  if (!key) throw Object.assign(new Error('NLS maps need a free API key: cm config nls-key YOUR_KEY (or env NLS_API_KEY)'), { status: 503 });
  const id = file;
  if (!inflight.has(id)) {
    inflight.set(id, (async () => {
      const r = await fetch(`${nlsBase()}/${layer}/default/WGS84_Pseudo-Mercator/${z}/${y}/${x}.${ext}?api-key=${encodeURIComponent(key)}`, { headers: { 'user-agent': 'Spread map proxy' } });
      if (!r.ok) throw Object.assign(new Error(`NLS ${r.status}`), { status: r.status === 401 || r.status === 403 ? 503 : 502 });
      const body = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return body;
    })().finally(() => inflight.delete(id)));
  }
  return { body: await inflight.get(id), type, cached: false };
}
