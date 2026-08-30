/**
 * 鹿豹 · 路況回報後端 (Cloudflare Worker + KV)
 * ================================================================
 * 免費方案就夠跑：Workers 每天 10 萬次請求、KV 每天 10 萬次讀 / 1000 次寫。
 *
 * API
 *   GET  /hazards?lat=&lon=&r=8000      查附近有效事件
 *   POST /report                        新增一筆回報
 *   POST /hazards/:id/confirm           我也看到了（提高可信度）
 *   POST /hazards/:id/clear             已經清掉了（別人說的，2 票就消失）
 *   POST /hazards/:id/retract           回報者本人撤銷（立即生效，不用投票）
 *   POST /hazards/:id/probe             被動車流探針（App 自動送，使用者不用操作）
 *   GET  /stats                         簡單統計
 *
 * 自動下架機制（不需要有人顧後台）：
 *   1. 置信度隨時間依類型半衰期衰減
 *   2. 經過的車有沒有減速 → 自動修正置信度（最有效的訊號）
 *   3. 官方事件（1968/TDX）說結束 → 直接歸零
 *   4. 分數低於門檻就不再回傳，等於自動下架
 *
 * 空間索引：用 0.05°（約 5.5 公里）的網格當 KV key 前綴，查詢時掃 3x3 或 5x5 格。
 * 沒有資料庫、沒有 PostGIS，KV 就夠了。
 *
 * 隱私：不存照片、不存帳號。只留一個匿名裝置代號（客戶端產生的隨機字串的雜湊），
 * 用途僅限於防止同一支手機灌爆同一個地點。
 */

const TTL = {                      // 各類事件的存活時間（毫秒）
  '掉落物': 2 * 3600e3,
  '事故': 2 * 3600e3,
  '車輛故障': 1 * 3600e3,
  '塞車': 45 * 60e3,
  '施工': 12 * 3600e3,
  '路面坑洞': 24 * 3600e3,
  '積水': 6 * 3600e3,
  '動物': 1 * 3600e3,
  '臨檢': 3 * 3600e3,
  '其他': 2 * 3600e3,
};
const DEFAULT_TTL = 2 * 3600e3;
const MAX_TTL = 48 * 3600e3;

/**
 * 置信度半衰期（分鐘）。
 * 這是整套自動下架機制的核心 —— 事件不是「到期才消失」，
 * 而是分數隨時間衰減，被人確認會回升、被車流否證會下降。
 * 數字依各類型「通常多久會被排除」設定：
 *   事故 25 分鐘（多數 30~60 分鐘內排除）、塞車 15（車流變化最快）、
 *   施工 240（半天）、坑洞 720（要等養護排程）。
 */
const HALF_LIFE_MIN = {
  '事故': 25, '車輛故障': 20, '掉落物': 45, '塞車': 15,
  '施工': 240, '路面坑洞': 720, '積水': 180, '動物': 20,
  '臨檢': 60, '其他': 45,
};
// 分數低於這個值就不再回傳給客戶端（等於自動下架）
const SCORE_HIDE = 0.40;
// 每個「沒減速通過」的探針把分數乘以這個係數；「有明顯減速」則乘以下面那個
const PROBE_CLEAR = 0.72;
const PROBE_STILL = 1.18;
const PROBE_MAX = 40;              // 只保留最近這麼多筆探針

const CELL = 0.05;                 // 網格大小（度）≈ 5.5 公里
const MAX_RADIUS = 30000;          // 查詢半徑上限（公尺）
const CLEAR_THRESHOLD = 2;         // 幾個人說清掉了就隱藏
const POST_COOLDOWN_MS = 20e3;     // 同一裝置連續回報的最短間隔
const NEAR_DUP_M = 150;            // 這個距離內的同類事件視為同一件，改成加確認

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

const cellOf = (lat, lon) => `${Math.floor(lat / CELL)}_${Math.floor(lon / CELL)}`;

function distM(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180;
  const p = a * r, q = c * r, dp = (c - a) * r, dl = (d - b) * r;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function angDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// 去掉控制字元（含換行），避免有人在 note 或型別欄位塞奇怪東西
const clean = (s, max) =>
  String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function ttlFor(type) {
  return Math.min(MAX_TTL, TTL[type] || DEFAULT_TTL);
}

/**
 * 目前置信度。
 *   基數   = 2 + 確認人數
 *   時間   = 依類型半衰期指數衰減
 *   車流   = 每筆探針依「有沒有減速」上下修
 *   官方   = 官方資料說已排除就直接歸零
 */
function scoreOf(h, now) {
  if (h.officialCleared) return 0;
  const hl = (HALF_LIFE_MIN[h.type] || HALF_LIFE_MIN['其他']) * 60e3;
  const ageMs = Math.max(0, now - (h.lastReport || h.t));
  // 基數 2 起跳：剛回報時一定高於出聲門檻；每多一人確認 +1，警示期跟著延長
  let s = (2 + (h.confirms || 0)) * Math.pow(0.5, ageMs / hl);
  const p = h.probes || { clear: 0, still: 0 };
  s *= Math.pow(PROBE_CLEAR, p.clear || 0);
  s *= Math.min(3, Math.pow(PROBE_STILL, p.still || 0));
  // 官方事件仍在進行 → 給一個下限，不讓它自己衰減掉
  if (h.officialOpen) s = Math.max(s, 1.2);
  return Math.round(s * 1000) / 1000;
}

function isAlive(h, now) {
  if (!h) return false;
  if (h.retracted) return false;                       // 回報者自己撤回
  if ((h.clears || 0) >= CLEAR_THRESHOLD) return false;
  if (scoreOf(h, now) < SCORE_HIDE) return false;      // 置信度太低 = 自動下架
  return h.expires > now;
}

/** 回給客戶端的形狀：只給需要的欄位，不外流裝置代號 */
function publicShape(h) {
  return {
    id: h.id, type: h.type, lat: h.lat, lon: h.lon,
    road: h.road || '', roadClass: h.roadClass || '一般道路',
    dir: h.dir || '', km: h.km == null ? null : h.km,
    brg: h.brg == null ? null : h.brg,
    note: h.note || '', lane: h.lane || '',
    t: h.t, expires: h.expires,
    confirms: h.confirms || 0, clears: h.clears || 0,
    // 回報人數 = 第一個回報的人 + 後續確認的人。客戶端直接顯示這個數字。
    reports: 1 + (h.confirms || 0),
    lastReport: h.lastReport || h.t,
    score: scoreOf(h, Date.now()),
    probes: { clear: (h.probes && h.probes.clear) || 0,
              still: (h.probes && h.probes.still) || 0 },
    official: h.officialOpen ? 'open' : (h.officialCleared ? 'cleared' : null),
  };
}

async function listCells(env, lat, lon, radius) {
  const span = Math.ceil(radius / (CELL * 111320)) + 1;   // 需要掃幾圈網格
  const rings = Math.min(span, 6);
  const keys = [];
  for (let dx = -rings; dx <= rings; dx++) {
    for (let dy = -rings; dy <= rings; dy++) {
      keys.push(`h:${cellOf(lat + dx * CELL, lon + dy * CELL)}:`);
    }
  }
  const seen = new Set(), out = [];
  for (const prefix of keys) {
    const res = await env.HAZARDS.list({ prefix, limit: 200 });
    for (const k of res.keys) {
      if (seen.has(k.name)) continue;
      seen.add(k.name);
      out.push(k.name);
    }
  }
  return out;
}

async function getMany(env, keys) {
  const out = [];
  // KV 沒有批次讀，分批併發避免一次開太多連線
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    const vals = await Promise.all(chunk.map(k => env.HAZARDS.get(k, 'json')));
    vals.forEach(v => { if (v) out.push(v); });
  }
  return out;
}

async function handleQuery(env, url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const r = Math.min(MAX_RADIUS, parseFloat(url.searchParams.get('r')) || 8000);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '需要 lat 與 lon' }, 400);

  const now = Date.now();
  const keys = await listCells(env, lat, lon, r);
  const all = await getMany(env, keys);
  const near = all
    .filter(h => isAlive(h, now))
    .map(h => ({ h, d: distM(lat, lon, h.lat, h.lon) }))
    .filter(x => x.d <= r)
    .sort((a, b) => a.d - b.d)
    .slice(0, 200)
    .map(x => ({ ...publicShape(x.h), dist: Math.round(x.d) }));

  return json({ ok: true, now, count: near.length, hazards: near });
}

async function handleReport(env, req) {
  let b;
  try { b = await req.json(); } catch { return json({ error: 'JSON 格式錯誤' }, 400); }

  const lat = parseFloat(b.lat), lon = parseFloat(b.lon);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '缺少座標' }, 400);
  if (lat < 21.5 || lat > 26.5 || lon < 118 || lon > 122.5)
    return json({ error: '座標不在台灣範圍內' }, 400);

  const type = clean(b.type, 20) || '其他';
  const device = clean(b.device, 64) || 'anon';
  const now = Date.now();

  // 同一裝置的冷卻，擋住手滑連按與惡意灌水
  const ckey = `c:${device}`;
  const last = await env.HAZARDS.get(ckey);
  if (last && now - Number(last) < POST_COOLDOWN_MS) {
    return json({ error: '太頻繁了，請稍候再回報', retryAfterMs: POST_COOLDOWN_MS - (now - Number(last)) }, 429);
  }

  const brg = isFinite(parseFloat(b.brg)) ? ((parseFloat(b.brg) % 360) + 360) % 360 : null;

  // 附近已經有同類事件 → 併成確認，不要製造重複點
  const keys = await listCells(env, lat, lon, NEAR_DUP_M);
  const existing = (await getMany(env, keys)).filter(h => isAlive(h, now) && h.type === type);
  for (const h of existing) {
    if (distM(lat, lon, h.lat, h.lon) > NEAR_DUP_M) continue;
    // 方向差太多視為對向車道的另一件事
    if (brg != null && h.brg != null && angDiff(brg, h.brg) > 60) continue;
    h.confirms = (h.confirms || 0) + 1;
    h.lastReport = now;
    h.expires = Math.max(h.expires, now + ttlFor(type));   // 有人再次看到就延長
    await env.HAZARDS.put(`h:${cellOf(h.lat, h.lon)}:${h.id}`, JSON.stringify(h),
      { expirationTtl: Math.ceil((h.expires - now) / 1000) + 300 });
    await env.HAZARDS.put(ckey, String(now), { expirationTtl: 120 });
    return json({ ok: true, merged: true, hazard: publicShape(h) });
  }

  const id = crypto.randomUUID().slice(0, 8);
  const h = {
    id, type,
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    road: clean(b.road, 24),
    roadClass: clean(b.roadClass, 12) || '一般道路',
    dir: clean(b.dir, 12),
    km: isFinite(parseFloat(b.km)) ? Math.round(parseFloat(b.km) * 10) / 10 : null,
    lane: clean(b.lane, 12),
    brg,
    note: clean(b.note, 120),
    t: now,
    lastReport: now,
    expires: now + ttlFor(type),
    confirms: 0, clears: 0,
    probes: { clear: 0, still: 0 },
    by: device.slice(0, 12),
  };
  await env.HAZARDS.put(`h:${cellOf(h.lat, h.lon)}:${id}`, JSON.stringify(h),
    { expirationTtl: Math.ceil(ttlFor(type) / 1000) + 300 });
  await env.HAZARDS.put(ckey, String(now), { expirationTtl: 120 });
  return json({ ok: true, merged: false, hazard: publicShape(h) });
}

async function handleVote(env, req, id, kind) {
  let b = {};
  try { b = await req.json(); } catch { /* 允許空 body */ }
  const lat = parseFloat(b.lat), lon = parseFloat(b.lon);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '需要 lat 與 lon 以定位事件' }, 400);

  const now = Date.now();
  const keys = await listCells(env, lat, lon, 2000);
  const all = await getMany(env, keys);
  const h = all.find(x => x.id === id);
  if (!h) return json({ error: '找不到這筆事件（可能已過期）' }, 404);

  if (kind === 'confirm') {
    h.confirms = (h.confirms || 0) + 1;
    h.lastReport = now;
    h.expires = Math.max(h.expires, now + ttlFor(h.type));
  } else {
    h.clears = (h.clears || 0) + 1;
  }
  const key = `h:${cellOf(h.lat, h.lon)}:${h.id}`;
  if (!isAlive(h, now)) {
    await env.HAZARDS.delete(key);
    return json({ ok: true, removed: true });
  }
  await env.HAZARDS.put(key, JSON.stringify(h),
    { expirationTtl: Math.max(60, Math.ceil((h.expires - now) / 1000) + 300) });
  return json({ ok: true, hazard: publicShape(h) });
}

/**
 * 回報者撤銷自己的回報。
 * 這跟「已清除」投票是兩件事：投票是別人說東西不在了（需要 2 票），
 * 撤銷是我自己按錯或看錯，應該立刻生效、不需要別人同意。
 * 用建立當下存的匿名裝置代號比對，只有本人撤得掉。
 */
async function handleRetract(env, req, id) {
  let b = {};
  try { b = await req.json(); } catch { /* 允許空 body */ }
  const lat = parseFloat(b.lat), lon = parseFloat(b.lon);
  const device = clean(b.device, 64);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '需要 lat 與 lon 以定位事件' }, 400);
  if (!device) return json({ error: '需要 device 才能證明是本人' }, 400);

  const now = Date.now();
  const all = await getMany(env, await listCells(env, lat, lon, 2000));
  const h = all.find(x => x.id === id);
  if (!h) return json({ error: '找不到這筆事件（可能已過期）' }, 404);
  if ((h.by || '') !== device.slice(0, 12))
    return json({ error: '這不是你回報的事件。若你確認現場已排除，請改用「已經清掉了」' }, 403);

  await env.HAZARDS.delete(`h:${cellOf(h.lat, h.lon)}:${h.id}`);
  return json({ ok: true, retracted: true });
}

/**
 * 被動車流探針 —— 整套自動下架機制裡最有用的訊號。
 *
 * 使用者經過事件點時，App 自動比對「有沒有比自己剛才的巡航速度慢下來」。
 * 沒減速 = 東西大概不在了；明顯減速 = 還在。完全不需要使用者按任何東西。
 *
 * 隱私：只收 slowed 這個布林值，不收速度、不收座標、不收裝置代號。
 * 後端只把它累加成兩個計數器，無法反推是誰經過。
 */
async function handleProbe(env, req, id) {
  let b = {};
  try { b = await req.json(); } catch { return json({ error: 'JSON 格式錯誤' }, 400); }
  const lat = parseFloat(b.lat), lon = parseFloat(b.lon);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '需要 lat 與 lon 以定位事件' }, 400);

  const now = Date.now();
  const all = await getMany(env, await listCells(env, lat, lon, 2000));
  const h = all.find(x => x.id === id);
  if (!h) return json({ error: 'not found' }, 404);

  h.probes = h.probes || { clear: 0, still: 0 };
  if (b.slowed) h.probes.still = Math.min(PROBE_MAX, (h.probes.still || 0) + 1);
  else h.probes.clear = Math.min(PROBE_MAX, (h.probes.clear || 0) + 1);

  const score = scoreOf(h, now);
  const key = `h:${cellOf(h.lat, h.lon)}:${h.id}`;
  if (!isAlive(h, now)) {
    await env.HAZARDS.delete(key);
    return json({ ok: true, removed: true, reason: '車流顯示已排除', score });
  }
  await env.HAZARDS.put(key, JSON.stringify(h),
    { expirationTtl: Math.max(60, Math.ceil((h.expires - now) / 1000) + 300) });
  return json({ ok: true, score, probes: h.probes });
}

/* ═══════════════════════════════════════════════════════════
   官方事件對帳（排程執行，不需要有人顧後台）

   邏輯很單純：官方（1968 / TDX）本來就有事故與施工的「結束時間」。
   使用者回報了 10:00 的事故，官方在 10:35 標記排除 —— 我們照著關掉就好。

   對帳靠三個條件同時成立：
     · 距離   500 公尺內
     · 方向   夾角 90° 內（避免關掉對向的事件）
     · 類型   事故↔事故、施工↔施工

   官方事件仍在進行 → officialOpen=true，置信度給下限不讓它自己衰減掉
   官方事件已經結束 → officialCleared=true，置信度直接歸零 → 下一次查詢就消失
   ═══════════════════════════════════════════════════════════ */

const OFFICIAL_MATCH_M = 500;

/** 把官方事件的文字對應到我們的類型 */
function officialType(text) {
  const t = String(text || '');
  if (/事故|碰撞|翻覆|追撞/.test(t)) return '事故';
  if (/施工|養護|封閉|管制/.test(t)) return '施工';
  if (/拋錨|故障/.test(t)) return '車輛故障';
  if (/障礙物|散落|掉落/.test(t)) return '掉落物';
  if (/壅塞|回堵/.test(t)) return '塞車';
  return null;
}

/**
 * 從 TDX 取即時事件。
 * ⚠️ 端點路徑請對照 TDX Swagger 確認 —— 這裡用環境變數帶入，方便日後調整
 *    而不用改程式碼：wrangler secret put TDX_ID / TDX_SECRET，
 *    以及 vars 裡的 TDX_INCIDENT_URL。
 */
async function fetchOfficial(env) {
  if (!env.TDX_ID || !env.TDX_SECRET || !env.TDX_INCIDENT_URL) return null;
  const tk = await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials',
                                client_id: env.TDX_ID, client_secret: env.TDX_SECRET }),
  }).then(r => r.ok ? r.json() : null);
  if (!tk || !tk.access_token) return null;

  const r = await fetch(env.TDX_INCIDENT_URL, {
    headers: { authorization: 'Bearer ' + tk.access_token, accept: 'application/json' },
  });
  if (!r.ok) return null;
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j.Incidents || j.Newses || j.LiveTraffics || j.data || []);
  const now = Date.now();
  return arr.map(o => {
    const lat = parseFloat(o.PositionLat ?? o.Latitude ?? o.Lat);
    const lon = parseFloat(o.PositionLon ?? o.Longitude ?? o.Lon);
    const end = o.EndTime || o.ExpectEndTime || o.ModifiedTime;
    return {
      lat, lon,
      type: officialType((o.Description || '') + (o.Title || '') + (o.IncidentType || '')),
      dir: o.Direction || o.RoadDirection || '',
      endMs: end ? Date.parse(end) : null,
      ended: end ? (Date.parse(end) < now) : false,
    };
  }).filter(x => isFinite(x.lat) && isFinite(x.lon) && x.type);
}

/** 官方事件的方向字串 → 方位角，用來排除對向 */
function dirToBrg(s) {
  const t = String(s || '');
  if (/南下|北往南/.test(t)) return 180;
  if (/北上|南往北/.test(t)) return 0;
  if (/東行|西往東/.test(t)) return 90;
  if (/西行|東往西/.test(t)) return 270;
  return null;
}

async function reconcile(env) {
  const official = await fetchOfficial(env);
  if (!official) return { skipped: '未設定 TDX 金鑰或取得失敗' };

  const now = Date.now();
  const res = await env.HAZARDS.list({ prefix: 'h:', limit: 1000 });
  let opened = 0, closed = 0, checked = 0;

  for (const k of res.keys) {
    const h = await env.HAZARDS.get(k.name, 'json');
    if (!h || h.retracted) continue;
    checked++;
    let best = null;
    for (const o of official) {
      if (o.type !== h.type) continue;
      const d = distM(h.lat, h.lon, o.lat, o.lon);
      if (d > OFFICIAL_MATCH_M) continue;
      const ob = dirToBrg(o.dir);
      if (ob != null && h.brg != null && angDiff(ob, h.brg) > 90) continue;
      if (!best || d < best.d) best = { o, d };
    }
    if (!best) continue;

    if (best.o.ended) {
      // 官方說結束了 → 直接關掉，不必等衰減
      await env.HAZARDS.delete(k.name);
      closed++;
    } else {
      h.officialOpen = true;
      h.officialCleared = false;
      // 官方有預計結束時間就照它設定到期
      if (best.o.endMs && best.o.endMs > now) h.expires = Math.min(now + MAX_TTL, best.o.endMs + 5 * 60e3);
      await env.HAZARDS.put(k.name, JSON.stringify(h),
        { expirationTtl: Math.max(60, Math.ceil((h.expires - now) / 1000) + 300) });
      opened++;
    }
  }
  return { checked, matchedOpen: opened, autoClosed: closed, officialCount: official.length };
}

export default {
  /** Cloudflare 排程觸發：對帳官方事件。在 wrangler.toml 設 crons。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reconcile(env).then(r => console.log('reconcile', JSON.stringify(r))));
  },

  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (!env.HAZARDS) return json({ error: '尚未綁定 KV namespace（HAZARDS）' }, 500);

      if (req.method === 'GET' && (p === '/hazards' || p === '/')) return handleQuery(env, url);
      if (req.method === 'POST' && p === '/report') return handleReport(env, req);

      const m = p.match(/^\/hazards\/([A-Za-z0-9-]{4,40})\/(confirm|clear)$/);
      if (req.method === 'POST' && m) return handleVote(env, req, m[1], m[2]);

      const mr = p.match(/^\/hazards\/([A-Za-z0-9-]{4,40})\/retract$/);
      if (req.method === 'POST' && mr) return handleRetract(env, req, mr[1]);

      const mp = p.match(/^\/hazards\/([A-Za-z0-9-]{4,40})\/probe$/);
      if (req.method === 'POST' && mp) return handleProbe(env, req, mp[1]);

      if (req.method === 'POST' && p === '/reconcile') {
        if (env.ADMIN_TOKEN && req.headers.get('x-admin-token') !== env.ADMIN_TOKEN)
          return json({ error: 'unauthorized' }, 401);
        return json({ ok: true, ...(await reconcile(env)) });
      }

      if (req.method === 'GET' && p === '/stats') {
        const res = await env.HAZARDS.list({ prefix: 'h:', limit: 1000 });
        return json({ ok: true, stored: res.keys.length, truncated: !res.list_complete });
      }
      return json({ error: 'not found', paths: ['/hazards', '/report',
        '/hazards/:id/confirm', '/hazards/:id/clear',
        '/hazards/:id/retract', '/hazards/:id/probe', '/stats'] }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
