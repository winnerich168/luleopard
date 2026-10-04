/**
 * 後端邏輯測試：用本機 SQLite（node:sqlite）模擬 Cloudflare D1，直接跑 worker.js。
 * 資料表就是 schema.sql 本身，所以 SQL 寫錯在這裡就會炸，不用等部署。
 * 不需要 wrangler 也不需要網路。
 *   node backend/test_worker.mjs
 */
import worker from './worker.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// ── 假的 Cloudflare D1（prepare → bind → all / first / run）──────────
const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { prepare: sql => stmt(sql) };
}
// 測試用：直接塞一筆（繞過 API，模擬舊資料）
const putRaw = (e, h) => e.DB.prepare('INSERT OR REPLACE INTO hazards (id, lat, lon, expires, data) VALUES (?1, ?2, ?3, ?4, ?5)')
  .bind(h.id, h.lat, h.lon, h.expires, JSON.stringify(h)).run();
const metaGet = async (e, k) => { const r = await e.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind(k).first(); return r ? JSON.parse(r.v) : null; };
const metaSet = (e, k, v) => e.DB.prepare('INSERT OR REPLACE INTO meta (k, v, exp) VALUES (?1, ?2, NULL)').bind(k, JSON.stringify(v)).run();
const metaDel = (e, k) => e.DB.prepare('DELETE FROM meta WHERE k = ?1').bind(k).run();

const env = { DB: makeD1() };
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
  await putRaw(env, stale);
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
  // scoreOf 沒外流，改用 API 觀察：塞幾筆不同年紀的事故進資料庫，看查詢會不會回傳
  await putRaw(env, { ...mk('事故', 5), id: 'fresh' });
  await putRaw(env, { ...mk('事故', 90), id: 'stale' });
  await putRaw(env, { ...mk('事故', 20, 0, 4), id: 'probed' });
  await putRaw(env, { ...mk('事故', 40, 4), id: 'confirmed' });
  await putRaw(env, { ...mk('施工', 180), id: 'roadwork' });

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

console.log('\n── 官方即時事件（TDX RoadEvent/LiveEvent，實際回應節錄）──');
{
  const FX = JSON.parse((await import('node:fs')).readFileSync(new URL('./fixtures/tdx_live_events.json', import.meta.url), 'utf8'));
  const realFetch = globalThis.fetch;
  let fail503 = false;
  globalThis.fetch = async (u, opt) => {
    u = String(u);
    if (u.includes('/token')) return new Response(JSON.stringify({ access_token: 'tk' }), { status: 200 });
    if (fail503 && u.includes('Highway')) return new Response('{}', { status: 503 });
    if (u.includes('LiveEvent/Freeway')) return new Response(JSON.stringify(FX.Freeway), { status: 200 });
    if (u.includes('LiveEvent/Highway')) return new Response(JSON.stringify(FX.Highway), { status: 200 });
    return realFetch(u, opt);
  };
  const env2 = { DB: makeD1(), TDX_ID: 'id', TDX_SECRET: 'sec' };
  const call2 = async (method, path, body) => {
    const res = await worker.fetch(new Request(BASE + path, { method,
      headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), env2);
    return { status: res.status, body: await res.json() };
  };

  const r = await call2('POST', '/reconcile');
  t('有金鑰時會抓官方事件', r.status === 200 && r.body.officialCount > 0, r.body);
  const stored = await metaGet(env2, 'official');
  t('「機動開放路肩」不列入（無影響、數量多，唸了只是噪音）',
    stored && !stored.items.some(x => /路肩/.test(x.note)), stored && stored.items.map(x => x.note));
  t('座標從 WKT POINT 解析（經度在前）', stored.items.every(x => x.lat > 21 && x.lat < 26 && x.lon > 119 && x.lon < 123));

  // 國道三號南向 410.1K 交通事故（屏東）
  const acc = stored.items.find(x => x.type === '事故');
  t('交通事故對應成「事故」', !!acc, stored.items.map(x => x.type));
  t('里程 410K+100 → 410.1', acc && acc.km === 410.1, acc);
  t('國道歸類為國道', acc && acc.roadClass === '國道');

  const q = await call2('GET', `/hazards?lat=${acc.lat - 2000 / 111320}&lon=${acc.lon}&r=15000`);
  const oa = q.body.hazards.find(h => h.id === acc.id);
  t('查附近時會附上官方事件', !!oa && q.body.official >= 1, q.body);
  t('回傳官方清單的更新時間', typeof q.body.officialT === 'number' && Date.now() - q.body.officialT < 60e3, q.body.officialT);
  t('官方事件標記為 official', oa && oa.official === 'open' && oa.src === 'official');
  t('南向 → 方位角 180', oa && oa.brg === 180);
  t('方向容許角放寬（彎道不漏報）', oa && oa.brgTol === 110);
  t('官方事件 id 符合路由格式', oa && /^[A-Za-z0-9-]{4,40}$/.test(oa.id));

  t('官方事件帶發生時間 since（App 唸「N 分鐘前」用）', oa && typeof oa.since === 'number' && oa.since < Date.now(), oa && oa.since);

  // 用路人對官方事件的回饋：以前按「已經清掉了」會 404
  {
    const hw0 = stored.items.find(x => x.road === '台72');
    const at = { lat: hw0.lat, lon: hw0.lon };
    const v1 = await call2('POST', `/hazards/${hw0.id}/clear`, at);
    t('官方事件可以回報已清除', v1.status === 200 && v1.body.official && !v1.body.removed, v1.body);
    const v2 = await call2('POST', `/hazards/${hw0.id}/confirm`, at);
    t('有人說還在 → 抵掉一張清除票', v2.status === 200 && v2.body.hazard.clears === 0, v2.body);
    await call2('POST', `/hazards/${hw0.id}/clear`, at);
    const v4 = await call2('POST', `/hazards/${hw0.id}/clear`, at);
    t('兩人說已清除 → 這筆官方事件先不提供', v4.body.removed === true, v4.body);
    const qv = await call2('GET', `/hazards?lat=${hw0.lat}&lon=${hw0.lon}&r=3000`);
    t('被用路人回報清除的官方事件查不到', !qv.body.hazards.some(h => h.id === hw0.id), qv.body.hazards.map(h => h.id));
    // 經過都沒減速的車流探針也算
    const other = stored.items.find(x => x.id !== hw0.id && x.id !== acc.id);
    if (other) {
      for (let i = 0; i < 3; i++) await call2('POST', `/hazards/${other.id}/probe`, { lat: other.lat, lon: other.lon, slowed: false });
      const qp = await call2('GET', `/hazards?lat=${other.lat}&lon=${other.lon}&r=3000`);
      t('3 台車經過都沒減速 → 官方事件先不提供', !qp.body.hazards.some(h => h.id === other.id));
    }
    await metaDel(env2, 'official_votes');
  }

  const hw = stored.items.find(x => x.road === '台72');
  t('省道施工也有', hw && hw.type === '施工' && hw.dir === '雙向');
  const qh = await call2('GET', `/hazards?lat=${hw.lat}&lon=${hw.lon}&r=3000`);
  t('雙向 → 不帶方位角（兩個方向都要報）', qh.body.hazards.find(h => h.id === hw.id)?.brg === null);

  // 使用者在同一地點回報了事故 → 官方那筆不重複給
  const rep = await call2('POST', '/report', { lat: acc.lat, lon: acc.lon, type: '事故', roadClass: '國道', brg: 180, device: 'dev-o1' });
  const q2 = await call2('GET', `/hazards?lat=${acc.lat}&lon=${acc.lon}&r=3000`);
  t('使用者回報在旁邊時不重複給官方那筆', q2.body.hazards.filter(h => h.type === '事故').length === 1, q2.body.hazards);

  // 對帳：官方仍在 → 使用者回報標記 officialOpen
  await call2('POST', '/reconcile');
  const q3 = await call2('GET', `/hazards?lat=${acc.lat}&lon=${acc.lon}&r=3000`);
  const mine = q3.body.hazards.find(h => h.id === rep.body.hazard.id);
  t('官方仍在進行 → 使用者回報標記為官方確認', mine && mine.official === 'open', mine);

  // 官方清單上消失 = 已排除 → 使用者回報自動關掉
  const saved = FX.Freeway.LiveEvents;
  FX.Freeway.LiveEvents = saved.filter(e => e.EventType !== 1);
  const r4 = await call2('POST', '/reconcile');
  const q4 = await call2('GET', `/hazards?lat=${acc.lat}&lon=${acc.lon}&r=3000`);
  t('官方排除後，對應的使用者回報自動關掉', r4.body.autoClosed === 1 && !q4.body.hazards.some(h => h.type === '事故'), r4.body);
  FX.Freeway.LiveEvents = saved;

  // 其中一個來源失敗 → 整批作廢，不能拿半份清單去關別人的回報
  const before = await metaGet(env2, 'official');
  fail503 = true;
  const r5 = await call2('POST', '/reconcile');
  const after = await metaGet(env2, 'official');
  t('來源失敗時略過，不覆蓋上一份清單', !!r5.body.skipped && after.t === before.t, r5.body);
  fail503 = false;

  // 排程停擺太久 → 不再提供舊清單
  await metaSet(env2, 'official', { ...after, t: Date.now() - 31 * 60e3 });
  const q6 = await call2('GET', `/hazards?lat=${acc.lat}&lon=${acc.lon}&r=3000`);
  t('官方清單超過 30 分鐘沒更新就不提供', q6.body.official === 0, q6.body);

  // 憑證要快取：多次排程只申請一次（TDX 憑證服務有頻率限制，每次都申請會吃 429）
  let tokenCalls = 0;
  const wrapped = globalThis.fetch;
  globalThis.fetch = async (u, o) => { if (String(u).includes('/token')) tokenCalls++; return wrapped(u, o); };
  await metaDel(env2, 'tdx:token');
  await call2('POST', '/reconcile'); await call2('POST', '/reconcile'); await call2('POST', '/reconcile');
  t('TDX 憑證快取：三次排程只申請一次', tokenCalls === 1, tokenCalls);

  globalThis.fetch = realFetch;
}

console.log('\n── 免費額度（這次換 D1 的原因）──');
{
  const e = { DB: makeD1() };
  let n = 0;
  const orig = e.DB.prepare;
  e.DB.prepare = sql => { n++; return orig(sql); };
  for (let i = 0; i < 30; i++)
    await putRaw({ DB: { prepare: orig } }, { id: 'q' + i, type: '掉落物', lat: 24 + i * 0.01, lon: 121, t: Date.now(),
      lastReport: Date.now(), expires: Date.now() + 3600e3, confirms: 0, clears: 0 });
  n = 0;
  const res = await worker.fetch(new Request(BASE + '/hazards?lat=24.1&lon=121&r=15000'), e);
  const body = await res.json();
  t('查 15 公里半徑只用 2 個 SQL（事件＋官方清單）', n === 2 && body.count > 0, { sql: n, count: body.count });

  // 排程會清掉過期超過 1 小時的資料（D1 不像 KV 會自己過期）
  const e2 = { DB: makeD1() };
  await putRaw(e2, { id: 'old1', type: '掉落物', lat: 24, lon: 121, expires: Date.now() - 2 * 3600e3 });
  await putRaw(e2, { id: 'new1', type: '掉落物', lat: 24, lon: 121, expires: Date.now() + 3600e3 });
  await metaSet(e2, 'c:olddev', 1);
  await e2.DB.prepare('UPDATE meta SET exp = ?1 WHERE k = ?2').bind(Date.now() - 1000, 'c:olddev').run();
  const waits = [];
  await worker.scheduled({}, e2, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  const left = (await e2.DB.prepare('SELECT id FROM hazards').all()).results.map(r => r.id);
  t('排程清掉過期事件、保留有效的', left.length === 1 && left[0] === 'new1', left);
  t('排程清掉過期的冷卻紀錄', (await metaGet(e2, 'c:olddev')) === null);
}

console.log('\n── 沒綁資料庫時要講清楚 ──');
{
  const res = await worker.fetch(new Request(BASE + '/hazards?lat=25&lon=121'), {});
  const body = await res.json();
  t('回 500 並說明未綁 D1', res.status === 500 && /D1/.test(body.error), body);
}

console.log(`\n${'='.repeat(46)}\n通過 ${pass}　失敗 ${fail}\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
