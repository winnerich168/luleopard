/**
 * 後端邏輯測試：用一個假的 KV 直接跑 worker.js，不需要 wrangler 或網路。
 *   node backend/test_worker.mjs
 */
import worker from './worker.js';

// ── 假的 Cloudflare KV ────────────────────────────────────────
function makeKV() {
  const m = new Map();                       // key -> {v, exp}
  return {
    _m: m,
    async get(k, type) {
      const e = m.get(k);
      if (!e) return null;
      if (e.exp && e.exp < Date.now()) { m.delete(k); return null; }
      return type === 'json' ? JSON.parse(e.v) : e.v;
    },
    async put(k, v, opt) {
      m.set(k, { v, exp: opt?.expirationTtl ? Date.now() + opt.expirationTtl * 1000 : 0 });
    },
    async delete(k) { m.delete(k); },
    async list({ prefix, limit = 1000 }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit);
      return { keys: keys.map(name => ({ name })), list_complete: true };
    },
  };
}

const env = { HAZARDS: makeKV() };
const BASE = 'https://x.dev';

const call = async (method, path, body) => {
  const req = new Request(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, cors: res.headers.get('access-control-allow-origin'), body: await res.json() };
};

// 國道1號南下 47.5K 附近
const A = { lat: 25.048611, lon: 121.290833 };
const near = (m, brg = 180) => ({ lat: A.lat - m / 111320, lon: A.lon });

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
};

console.log('\n── CORS 與路由 ──');
{
  const pre = await worker.fetch(new Request(BASE + '/hazards', { method: 'OPTIONS' }), env);
  t('OPTIONS 回 CORS', pre.headers.get('access-control-allow-origin') === '*');
  const nf = await call('GET', '/nope');
  t('未知路徑回 404', nf.status === 404);
  const bad = await call('GET', '/hazards');
  t('缺座標回 400', bad.status === 400, bad.body);
}

console.log('\n── 新增回報 ──');
let id1;
{
  const r = await call('POST', '/report', {
    ...A, type: '掉落物', roadClass: '國道', road: '國道1號', dir: '南下',
    km: 47.5, brg: 180, note: '外側車道有輪胎皮', device: 'dev-A',
  });
  t('回報成功', r.status === 200 && r.body.ok, r.body);
  t('不是併入既有事件', r.body.merged === false);
  t('保留樁號', r.body.hazard.km === 47.5, r.body.hazard);
  t('回應不外流裝置代號', !('by' in r.body.hazard), Object.keys(r.body.hazard));
  id1 = r.body.hazard.id;
}
{
  const r = await call('POST', '/report', { ...A, type: '掉落物', device: 'dev-A' });
  t('同裝置冷卻擋下', r.status === 429, r.body);
}
{
  const r = await call('POST', '/report', { lat: 40.7, lon: -73.9, type: '掉落物', device: 'dev-Z' });
  t('台灣範圍外拒收', r.status === 400, r.body);
}
{
  // 故意放在別的地方，避免被併入既有事件而拿到舊的 note（那樣會假通過）
  const r = await call('POST', '/report', {
    lat: 22.9, lon: 120.2, type: '掉落物', note: 'a\u0000b\nc\u007f', device: 'dev-CLEAN' });
  t('建立新事件（不是併入）', r.body.merged === false, r.body);
  t('控制字元被清成空白並收斂', r.body.hazard.note === 'a b c', JSON.stringify(r.body.hazard.note));
}

console.log('\n── 近距離同類自動併成確認 ──');
{
  const r = await call('POST', '/report', {
    ...near(80), type: '掉落物', brg: 175, device: 'dev-B',
  });
  t('80 公尺內同類 → merged', r.body.merged === true, r.body);
  t('confirms 增加', r.body.hazard.confirms >= 1, r.body.hazard);
  t('沿用同一個 id', r.body.hazard.id === id1);
}
{
  const r = await call('POST', '/report', {
    ...near(80), type: '掉落物', brg: 0, device: 'dev-C',      // 對向
  });
  t('對向(方向差180°)視為另一件', r.body.merged === false, r.body);
}
{
  const r = await call('POST', '/report', { ...near(80), type: '事故', brg: 180, device: 'dev-D' });
  t('不同類型不併', r.body.merged === false, r.body);
}

console.log('\n── 查詢 ──');
{
  const r = await call('GET', `/hazards?lat=${A.lat}&lon=${A.lon}&r=3000`);
  t('查得到', r.body.count >= 3, r.body.count);
  t('有距離欄位且由近而遠', r.body.hazards.every((h, i, a) => i === 0 || a[i - 1].dist <= h.dist));
  t('CORS 開放', r.cors === '*');
  const far = await call('GET', `/hazards?lat=24.0&lon=120.5&r=3000`);
  t('遠處查不到', far.body.count === 0, far.body.count);
  const tiny = await call('GET', `/hazards?lat=${A.lat}&lon=${A.lon}&r=10`);
  t('半徑 10m 只剩最近的', tiny.body.count <= 2, tiny.body.count);
}

console.log('\n── 確認 / 已清除 ──');
{
  const before = (await call('GET', `/hazards?lat=${A.lat}&lon=${A.lon}&r=200`))
    .body.hazards.find(h => h.id === id1).confirms;
  const c = await call('POST', `/hazards/${id1}/confirm`, A);
  t('confirm 成功且累加 1', c.body.hazard.confirms === before + 1,
    {before, after: c.body.hazard.confirms});

  await call('POST', `/hazards/${id1}/clear`, A);
  const c2 = await call('POST', `/hazards/${id1}/clear`, A);
  t('兩票說清掉了 → 移除', c2.body.removed === true, c2.body);

  const after = await call('GET', `/hazards?lat=${A.lat}&lon=${A.lon}&r=3000`);
  t('查詢結果不再包含它', !after.body.hazards.some(h => h.id === id1));

  const gone = await call('POST', `/hazards/${id1}/confirm`, A);
  t('對已移除的事件 confirm 回 404', gone.status === 404, gone.body);
}

console.log('\n── 回報人數統計 ──');
{
  const P = { lat: 23.2, lon: 120.4 };
  const a = await call('POST', '/report', { ...P, type: '掉落物', brg: 180, device: 'r1' });
  t('第一個人回報 → 1 人', a.body.hazard.reports === 1, a.body.hazard);
  const b = await call('POST', '/report', { ...P, type: '掉落物', brg: 182, device: 'r2' });
  t('第二個人回報同一件 → 2 人', b.body.hazard.reports === 2, b.body.hazard);
  const c = await call('POST', `/hazards/${a.body.hazard.id}/confirm`, P);
  t('按「我也看到了」→ 3 人', c.body.hazard.reports === 3, c.body.hazard);
  const q = await call('GET', `/hazards?lat=${P.lat}&lon=${P.lon}&r=500`);
  const found = q.body.hazards.find(h => h.id === a.body.hazard.id);
  t('查詢也帶回人數', found && found.reports === 3, found);
  t('有 lastReport 時間戳', found && found.lastReport >= found.t, found);
}

console.log('\n── 過期 ──');
{
  // 塞一筆已經過期的進去，查詢時應被濾掉
  const stale = {
    id: 'stale001', type: '掉落物', lat: A.lat, lon: A.lon,
    t: Date.now() - 9e6, expires: Date.now() - 1000, confirms: 0, clears: 0,
  };
  await env.HAZARDS.put(`h:${Math.floor(A.lat / 0.05)}_${Math.floor(A.lon / 0.05)}:stale001`,
    JSON.stringify(stale));
  const r = await call('GET', `/hazards?lat=${A.lat}&lon=${A.lon}&r=3000`);
  t('過期事件不會被回傳', !r.body.hazards.some(h => h.id === 'stale001'));
}

console.log('\n── TTL 依類型不同 ──');
{
  const a = await call('POST', '/report', { lat: 24.5, lon: 121.0, type: '掉落物', device: 'd1' });
  const b = await call('POST', '/report', { lat: 23.5, lon: 120.5, type: '施工', device: 'd2' });
  const ha = a.body.hazard, hb = b.body.hazard;
  t('掉落物約 2 小時', Math.abs((ha.expires - ha.t) - 2 * 3600e3) < 1000, ha.expires - ha.t);
  t('施工約 12 小時', Math.abs((hb.expires - hb.t) - 12 * 3600e3) < 1000, hb.expires - hb.t);
}

console.log('\n── 回報者撤銷（本人，立即生效）──');
{
  const P = { lat: 24.11, lon: 120.61 };
  const a = await call('POST', '/report', { ...P, type: '施工', brg: 180, device: 'owner-1' });
  const id = a.body.hazard.id;
  const wrong = await call('POST', `/hazards/${id}/retract`, { ...P, device: 'someone-else' });
  t('別人不能撤銷我的回報', wrong.status === 403, wrong.body);
  const noDev = await call('POST', `/hazards/${id}/retract`, P);
  t('沒帶 device 不能撤銷', noDev.status === 400, noDev.body);
  const ok = await call('POST', `/hazards/${id}/retract`, { ...P, device: 'owner-1' });
  t('本人撤銷成功', ok.body.retracted === true, ok.body);
  const q = await call('GET', `/hazards?lat=${P.lat}&lon=${P.lon}&r=1000`);
  t('撤銷後立刻查不到（不用等投票）', !q.body.hazards.some(h => h.id === id));
}

console.log('\n── 置信度衰減 ──');
{
  const mk = (type, ageMin, confirms, clear) => ({
    id: 'x', type, lat: 24.2, lon: 120.6,
    t: Date.now() - ageMin * 60e3, lastReport: Date.now() - ageMin * 60e3,
    confirms: confirms || 0, clears: 0, probes: { clear: clear || 0, still: 0 },
    expires: Date.now() + 3600e3,
  });
  const S = (...a) => worker.__scoreOf ? worker.__scoreOf(mk(...a)) : null;
  // scoreOf 沒外流，改用 API 觀察：塞一筆舊事故進 KV，看查詢會不會回傳
  const put = async (h, key) => env.HAZARDS.put(key, JSON.stringify(h));
  const cell = `${Math.floor(24.2 / 0.05)}_${Math.floor(120.6 / 0.05)}`;

  await put({ ...mk('事故', 5), id: 'fresh' }, `h:${cell}:fresh`);
  await put({ ...mk('事故', 90), id: 'stale' }, `h:${cell}:stale`);
  await put({ ...mk('事故', 20, 0, 4), id: 'probed' }, `h:${cell}:probed`);
  await put({ ...mk('事故', 40, 4), id: 'confirmed' }, `h:${cell}:confirmed`);
  await put({ ...mk('施工', 180), id: 'roadwork' }, `h:${cell}:roadwork`);

  const q = await call('GET', `/hazards?lat=24.2&lon=120.6&r=1000`);
  const got = Object.fromEntries(q.body.hazards.map(h => [h.id, h.score]));
  t('5 分鐘前的事故還在且分數高', got.fresh > 1.5, got);
  t('90 分鐘前的事故已自動下架', got.stale === undefined, got);
  t('4 台車沒減速 → 20 分鐘就下架', got.probed === undefined, got);
  t('4 人確認過的 40 分鐘事故仍在', got.confirmed > 1, got);
  t('施工 3 小時仍在（半衰期長）', got.roadwork > 0.9, got);
  t('回傳帶 score 欄位', typeof q.body.hazards[0].score === 'number');
}

console.log('\n── 被動車流探針 ──');
{
  const P = { lat: 23.9, lon: 120.7 };
  const a = await call('POST', '/report', { ...P, type: '掉落物', brg: 180, device: 'p-owner' });
  const id = a.body.hazard.id;
  const before = a.body.hazard.score;

  const p1 = await call('POST', `/hazards/${id}/probe`, { ...P, slowed: true });
  t('有減速 → 分數上升', p1.body.score > before, { before, after: p1.body.score });
  t('探針計數正確', p1.body.probes.still === 1 && p1.body.probes.clear === 0, p1.body.probes);

  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', `/hazards/${id}/probe`, { ...P, slowed: false });
  t('連續沒減速 → 最終自動移除', last.body.removed === true, last.body);
  t('移除時說明原因', /車流/.test(last.body.reason || ''), last.body);

  const q = await call('GET', `/hazards?lat=${P.lat}&lon=${P.lon}&r=500`);
  t('查詢已看不到', !q.body.hazards.some(h => h.id === id));

  const gone = await call('POST', `/hazards/${id}/probe`, { ...P, slowed: false });
  t('對已移除的事件送探針回 404', gone.status === 404);
}

console.log('\n── 排程對帳（沒設 TDX 金鑰時要安全略過）──');
{
  t('有 scheduled handler', typeof worker.scheduled === 'function');
  const r = await call('POST', '/reconcile');
  t('未設金鑰時明確略過而不是爆炸', r.status === 200 && !!r.body.skipped, r.body);
}

console.log('\n── 沒綁 KV 時要講清楚 ──');
{
  const res = await worker.fetch(new Request(BASE + '/hazards?lat=25&lon=121'), {});
  const body = await res.json();
  t('回 500 並說明未綁 KV', res.status === 500 && /KV/.test(body.error), body);
}

console.log(`\n${'='.repeat(46)}\n通過 ${pass}　失敗 ${fail}\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
