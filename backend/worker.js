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
 * 儲存：Cloudflare D1（SQLite）。查附近用經緯度方框 + 索引，一次查詢一個 SQL。
 * 以前用 KV 的網格前綴，一次查詢要 list 約 81 格；KV 免費方案一天只有 1000 次 list
 * 與 1000 次寫入，上線一天就會爆。資料表見 schema.sql。
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

/* ── 儲存層（D1）────────────────────────────────────────────
   所有資料存取都集中在這裡，handler 不直接碰 SQL。 */
const Store = {
  /** 方框內、還沒過期的事件（呼叫端再用 Haversine 精算距離） */
  async near(env, lat, lon, radius, now) {
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const r = await env.DB.prepare(
      'SELECT data FROM hazards WHERE lat BETWEEN ?1 AND ?2 AND lon BETWEEN ?3 AND ?4 AND expires > ?5 LIMIT 500')
      .bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon, now).all();
    return (r.results || []).map(x => JSON.parse(x.data));
  },
  async get(env, id) {
    const r = await env.DB.prepare('SELECT data FROM hazards WHERE id = ?1').bind(id).first();
    return r ? JSON.parse(r.data) : null;
  },
  async put(env, h) {
    await env.DB.prepare('INSERT OR REPLACE INTO hazards (id, lat, lon, expires, data) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(h.id, h.lat, h.lon, h.expires, JSON.stringify(h)).run();
  },
  async del(env, id) {
    await env.DB.prepare('DELETE FROM hazards WHERE id = ?1').bind(id).run();
  },
  async alive(env, now, limit = 2000) {
    const r = await env.DB.prepare('SELECT data FROM hazards WHERE expires > ?1 LIMIT ?2').bind(now, limit).all();
    return (r.results || []).map(x => JSON.parse(x.data));
  },
  async count(env, now) {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM hazards WHERE expires > ?1').bind(now).first();
    return r ? r.n : 0;
  },
  async meta(env, k) {
    const r = await env.DB.prepare('SELECT v, exp FROM meta WHERE k = ?1').bind(k).first();
    if (!r || (r.exp != null && r.exp < Date.now())) return null;
    return JSON.parse(r.v);
  },
  async setMeta(env, k, v, ttlMs) {
    await env.DB.prepare('INSERT OR REPLACE INTO meta (k, v, exp) VALUES (?1, ?2, ?3)')
      .bind(k, JSON.stringify(v), ttlMs ? Date.now() + ttlMs : null).run();
  },
  async delMeta(env, k) {
    await env.DB.prepare('DELETE FROM meta WHERE k = ?1').bind(k).run();
  },
  /** 清掉過期資料（排程順便做）。KV 會自己過期，D1 不會 */
  async sweep(env, now) {
    await env.DB.prepare('DELETE FROM hazards WHERE expires < ?1').bind(now - 3600e3).run();
    await env.DB.prepare('DELETE FROM meta WHERE exp IS NOT NULL AND exp < ?1').bind(now).run();
  },
};

async function handleQuery(env, url) {
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  const r = Math.min(MAX_RADIUS, parseFloat(url.searchParams.get('r')) || 8000);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '需要 lat 與 lon' }, 400);

  const now = Date.now();
  const all = await Store.near(env, lat, lon, r, now);
  const near = all
    .filter(h => isAlive(h, now))
    .map(h => ({ h, d: distM(lat, lon, h.lat, h.lon) }))
    .filter(x => x.d <= r)
    .sort((a, b) => a.d - b.d)
    .slice(0, 200)
    .map(x => ({ ...publicShape(x.h), dist: Math.round(x.d) }));

  const off = await officialNear(env, lat, lon, r, near, now);
  const merged = near.concat(off.list).sort((a, b) => a.dist - b.dist).slice(0, 200);
  // officialT：官方清單是什麼時候抓的，App 設定頁顯示「官方資料更新於 N 分鐘前」
  return json({ ok: true, now, count: merged.length, official: off.list.length, officialT: off.t, hazards: merged });
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
  const last = await Store.meta(env, ckey);
  if (last && now - Number(last) < POST_COOLDOWN_MS) {
    return json({ error: '太頻繁了，請稍候再回報', retryAfterMs: POST_COOLDOWN_MS - (now - Number(last)) }, 429);
  }

  const brg = isFinite(parseFloat(b.brg)) ? ((parseFloat(b.brg) % 360) + 360) % 360 : null;

  // 附近已經有同類事件 → 併成確認，不要製造重複點
  const existing = (await Store.near(env, lat, lon, NEAR_DUP_M, now)).filter(h => isAlive(h, now) && h.type === type);
  for (const h of existing) {
    if (distM(lat, lon, h.lat, h.lon) > NEAR_DUP_M) continue;
    // 方向差太多視為對向車道的另一件事
    if (brg != null && h.brg != null && angDiff(brg, h.brg) > 60) continue;
    h.confirms = (h.confirms || 0) + 1;
    h.lastReport = now;
    h.expires = Math.max(h.expires, now + ttlFor(type));   // 有人再次看到就延長
    await Store.put(env, h);
    await Store.setMeta(env, ckey, now, 120e3);
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
  await Store.put(env, h);
  await Store.setMeta(env, ckey, now, 120e3);
  return json({ ok: true, merged: false, hazard: publicShape(h) });
}

async function handleVote(env, req, id, kind) {
  let b = {};
  try { b = await req.json(); } catch { /* 允許空 body */ }
  const lat = parseFloat(b.lat), lon = parseFloat(b.lon);
  if (!isFinite(lat) || !isFinite(lon)) return json({ error: '需要 lat 與 lon 以定位事件' }, 400);

  const now = Date.now();
  const h = await Store.get(env, id);
  if (!h || h.expires <= now) return json({ error: '找不到這筆事件（可能已過期）' }, 404);

  if (kind === 'confirm') {
    h.confirms = (h.confirms || 0) + 1;
    h.lastReport = now;
    h.expires = Math.max(h.expires, now + ttlFor(h.type));
  } else {
    h.clears = (h.clears || 0) + 1;
  }
  if (!isAlive(h, now)) {
    await Store.del(env, h.id);
    return json({ ok: true, removed: true });
  }
  await Store.put(env, h);
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

  const h = await Store.get(env, id);
  if (!h) return json({ error: '找不到這筆事件（可能已過期）' }, 404);
  if ((h.by || '') !== device.slice(0, 12))
    return json({ error: '這不是你回報的事件。若你確認現場已排除，請改用「已經清掉了」' }, 403);

  await Store.del(env, h.id);
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
  const h = await Store.get(env, id);
  if (!h || h.expires <= now) return json({ error: 'not found' }, 404);

  h.probes = h.probes || { clear: 0, still: 0 };
  if (b.slowed) h.probes.still = Math.min(PROBE_MAX, (h.probes.still || 0) + 1);
  else h.probes.clear = Math.min(PROBE_MAX, (h.probes.clear || 0) + 1);

  const score = scoreOf(h, now);
  if (!isAlive(h, now)) {
    await Store.del(env, h.id);
    return json({ ok: true, removed: true, reason: '車流顯示已排除', score });
  }
  await Store.put(env, h);
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
  if (/拋錨|故障/.test(t)) return '車輛故障';
  if (/障礙物|散落|掉落/.test(t)) return '掉落物';
  if (/落石|坍方|土石|淹水|積水|災害/.test(t)) return '道路災害';
  if (/施工|養護|維修|工程/.test(t)) return '施工';
  if (/封閉|封路|管制/.test(t)) return '道路管制';
  if (/壅塞|回堵/.test(t)) return '塞車';
  return null;
}

/* TDX 道路即時事件（RoadEvent/LiveEvent）。實測（2026-09）有座標的是這一系列：
   國道（高公局）＋ 省道／快速道路（公路局）。縣市也有，但 22 個縣市要打 22 次，先不抓。 */
const TDX_EVENT_URLS = [
  'https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/Freeway?%24format=JSON',
  'https://tdx.transportdata.tw/api/basic/v1/Traffic/RoadEvent/LiveEvent/Highway?%24format=JSON',
];
const OFFICIAL_KEY = 'official';           // 整份官方事件清單存成 meta 表的一筆
const OFFICIAL_STALE_MS = 30 * 60e3;       // 排程停擺超過 30 分鐘就不再提供，寧缺勿錯
const OFFICIAL_DEDUPE_M = 300;             // 使用者回報已經在附近就不重複給官方那筆

/** "POINT(121.01 24.85)" / "POINT (121.01 24.85)" → {lat, lon} */
function wktPoint(s) {
  const m = String(s || '').match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
  return m ? { lon: parseFloat(m[1]), lat: parseFloat(m[2]) } : null;
}
/** "87K+290" → 87.29 */
function kmOf(s) {
  const m = String(s || '').match(/(\d+)\s*K\s*\+?\s*(\d+)?/i);
  return m ? Math.round((parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 1000 : 0)) * 10) / 10 : null;
}
function roadClassOf(road, freeway) {
  if (freeway || /^國道/.test(road)) return '國道';
  if (/^台6[1-8]|快速|高架/.test(road)) return '高架/快速道路';
  return '一般道路';
}
/** 很短的穩定雜湊，當作官方事件的 id（要符合 /hazards/:id 的格式） */
function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/**
 * TDX 一筆 LiveEvent → 我們的格式。不值得播報的回傳 null。
 * 國道的「特殊管制事件-機動開放路肩」一次就有三十幾筆、而且標明「無影響」，
 * 全部唸出來只會讓人把語音關掉。
 */
function officialFromTdx(o, freeway) {
  const pos = wktPoint(o.Positions);
  if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return null;
  const text = (o.EventTitle || '') + ' ' + (o.Description || '');
  if (/路肩/.test(text) && /開放/.test(text)) return null;
  if (o.Impact && o.Impact.Description === '無影響' && o.EventType === 4) return null;
  const type = officialType(text);
  if (!type) return null;
  const L = (o.Location && o.Location.FreeExpressHighway) || {};
  const road = clean(L.Road || '', 20);
  return {
    id: 'o-' + shortHash(String(o.EventID || text)),
    lat: pos.lat, lon: pos.lon, type,
    road, roadClass: roadClassOf(road, freeway),
    dir: clean(L.Direction || '', 10),
    km: kmOf(L.StartKM),
    note: clean(o.Description || o.EventTitle || '', 120),
    since: Date.parse(o.EffectiveTime || o.PublishTime || '') || null,
  };
}

/**
 * 從 TDX 取即時事件。回傳 null = 沒設金鑰或整個失敗（不要拿空清單去關掉別人的回報）。
 * 網址可用 TDX_INCIDENT_URL 覆寫（多個用逗號分隔），沒設就用上面實測過的兩個。
 */
/**
 * TDX 存取憑證。一次有效 24 小時，存在資料庫重複使用，快過期（剩不到 1 小時）才換新。
 * 以前每 10 分鐘的排程都重新申請一次，一天 144 次 —— 憑證服務有頻率限制，
 * 實際部署後馬上就吃到 429，整個官方事件功能等於沒作用。
 */
const TDX_TOKEN_KEY = 'tdx:token';
async function tdxToken(env, force) {
  const now = Date.now();
  if (!force) {
    const c = await Store.meta(env, TDX_TOKEN_KEY);
    if (c && c.tk && c.exp - now > 3600e3) return c.tk;
  }
  const r = await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials',
                                client_id: env.TDX_ID, client_secret: env.TDX_SECRET }),
  });
  if (!r.ok) { officialErr = 'token HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120); return null; }
  const j = await r.json();
  if (!j.access_token) { officialErr = 'token 沒有 access_token'; return null; }
  const exp = now + (j.expires_in || 86400) * 1000;
  await Store.setMeta(env, TDX_TOKEN_KEY, { tk: j.access_token, exp }, exp - now);
  return j.access_token;
}

let officialErr = '';                      // 最近一次失敗的原因，/reconcile 會回報，方便查問題
async function fetchOfficial(env) {
  officialErr = '';
  if (!env.TDX_ID || !env.TDX_SECRET) { officialErr = '未設定 TDX_ID / TDX_SECRET'; return null; }
  let tk = await tdxToken(env);
  if (!tk) return null;

  const urls = env.TDX_INCIDENT_URL
    ? env.TDX_INCIDENT_URL.split(/[,\s]+/).filter(Boolean) : TDX_EVENT_URLS;
  const out = [];
  let okCount = 0;
  for (const u of urls) {
    let r = await fetch(u, { headers: { authorization: 'Bearer ' + tk, accept: 'application/json' } });
    if (r.status === 401) {                // 快取的憑證被撤銷（例如換了金鑰）→ 強制換新重試一次
      tk = await tdxToken(env, true);
      if (!tk) return null;
      r = await fetch(u, { headers: { authorization: 'Bearer ' + tk, accept: 'application/json' } });
    }
    if (!r.ok) { officialErr += (officialErr ? '；' : '') + u.split('?')[0].split('/').pop() + ' HTTP ' + r.status; continue; }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.LiveEvents || j.Incidents || j.Newses || []);
    const freeway = /Freeway/i.test(u);
    arr.forEach(o => { const x = officialFromTdx(o, freeway); if (x) out.push(x); });
    okCount++;
  }
  // 任何一個來源失敗就整批作廢：少了半份清單，會把那半邊還在進行的事件誤判成「已結束」
  if (okCount !== urls.length) return null;
  return out;
}

/** 官方事件的方向字串 → 方位角，用來排除對向 */
function dirToBrg(s) {
  const t = String(s || '');
  if (/雙向/.test(t)) return null;
  if (/南下|南向|北往南/.test(t)) return 180;
  if (/北上|北向|南往北/.test(t)) return 0;
  if (/東行|東向|西往東/.test(t)) return 90;
  if (/西行|西向|東往西/.test(t)) return 270;
  return null;
}

async function reconcile(env) {
  const official = await fetchOfficial(env);
  if (!official) return { skipped: '未設定 TDX 金鑰或取得失敗', reason: officialErr };

  const now = Date.now();
  // 整份清單存一筆：查詢時只要多讀一次
  await Store.setMeta(env, OFFICIAL_KEY, { t: now, items: official }, 2 * 3600e3);

  let opened = 0, closed = 0, checked = 0;
  for (const h of await Store.alive(env, now)) {
    if (h.retracted) continue;
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

    if (!best) {
      /* 即時清單只列「進行中」的事件，沒有結束時間欄位。
         之前對上過官方、這次清單裡卻沒有了 = 官方已經排除 → 直接關掉，不必等衰減。
         從來沒對上過的（官方沒收錄）就不動，交給時間衰減與車流探針。 */
      if (h.officialOpen) { await Store.del(env, h.id); closed++; }
      continue;
    }
    if (!h.officialOpen) {                 // 狀態有變才寫，省 KV 寫入額度
      h.officialOpen = true;
      h.officialCleared = false;
      await Store.put(env, h);
    }
    opened++;
  }
  return { checked, matchedOpen: opened, autoClosed: closed, officialCount: official.length };
}

/**
 * 查詢時一併附上附近的官方進行中事件。
 * 使用者回報已經在附近（同類、300 公尺內）就不重複給；排程停擺太久就不給，寧缺勿錯。
 */
async function officialNear(env, lat, lon, r, userHazards, now) {
  const o = await Store.meta(env, OFFICIAL_KEY);
  if (!o || !Array.isArray(o.items) || now - o.t > OFFICIAL_STALE_MS) return { list: [], t: 0 };
  const out = [];
  for (const x of o.items) {
    const d = distM(lat, lon, x.lat, x.lon);
    if (d > r) continue;
    if (userHazards.some(u => u.type === x.type && distM(u.lat, u.lon, x.lat, x.lon) <= OFFICIAL_DEDUPE_M)) continue;
    out.push({
      id: x.id, type: x.type, lat: x.lat, lon: x.lon,
      road: x.road, roadClass: x.roadClass, dir: x.dir, km: x.km,
      brg: dirToBrg(x.dir),
      // 官方方向是整條路的名目方向（南向＝180°），彎道處實際行進方向可能差很多，
      // 容許角度放寬到 110°：彎道不漏報，對向（差 180°）仍然排除
      brgTol: 110,
      note: x.note, lane: '',
      // 時間用「這次提供的時間」：它在官方清單上就是進行中，不該在客戶端自己衰減掉
      t: now, lastReport: now, expires: now + 20 * 60e3,
      confirms: 0, clears: 0, reports: 1, score: 1.5,
      probes: { clear: 0, still: 0 },
      official: 'open', src: 'official',
      dist: Math.round(d),
    });
  }
  return { list: out, t: o.t };
}

export default {
  /** Cloudflare 排程觸發：對帳官方事件。在 wrangler.toml 設 crons。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await Store.sweep(env, Date.now());
      console.log('reconcile', JSON.stringify(await reconcile(env)));
    })());
  },

  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (!env.DB) return json({ error: '尚未綁定 D1 資料庫（DB）' }, 500);

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
        return json({ ok: true, stored: await Store.count(env, Date.now()), truncated: false });
      }
      return json({ error: 'not found', paths: ['/hazards', '/report',
        '/hazards/:id/confirm', '/hazards/:id/clear',
        '/hazards/:id/retract', '/hazards/:id/probe', '/stats'] }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};
