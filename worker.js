/* ============================================================
   mynote_bot — V17 CLEAN + SCHEDULE + ALBUM + SOURCE-CLEAN
   ترکیبی از:
   - V1.9/V1.10: تمیزکاری کپشن، حذف لینک، هشتگ هوشمند
   - V14: صف مستقل، Retry با backoff، DLQ، Album aggregation
   - V15.2: API بله، پشتیبانی از channel_post + message
   - V16: Auto-learn source، پنجرهٔ ساعتی قابل تنظیم
============================================================ */
const VERSION = "V17-CLEAN-2026-08-14";
const BALE_BASE = "https://tapi.bale.ai/bot";

const BRANDING_HASHTAG = "#یادبگیریم";

const KEYWORD_MAP = {
  'غذا': ['#تغذیه'], 'کیوی': ['#سلامتی'], 'سیگار': ['#سلامتی'],
  'تاریخ': ['#تاریخ'], 'ایران': ['#ایران'], 'کوروش': ['#تاریخ'],
  'دریاچه': ['#رازهای_طبیعت'], 'گنج': ['#شاه_کلید'], 'افسانه': ['#حقایق_جالب'],
  'ترفند': ['#ترفند'], 'زندگی': ['#ترفند_زندگی'], 'معما': ['#معما'],
  'طبیعت': ['#رازهای_طبیعت'], 'خلاق': ['#خلاقیت'], 'دانستنی': ['#دانستنی'],
  'ارگ': ['#تاریخ'], 'علیشاه': ['#تاریخ'], 'تبریز': ['#ایران'],
  'مسجد': ['#تاریخ'], 'معماری': ['#هنر'], 'کاشی': ['#هنر'],
  'الماس': ['#اقتصاد'], 'ماشین': ['#اقتصاد'], 'هواپیما': ['#تکنولوژی'],
  'آمازون': ['#دانستنی'], 'عکس': ['#هنر'], 'مغز': ['#دانستنی'],
  'ورزش': ['#سلامتی'], 'کتاب': ['#دانستنی']
};

const DEFAULTS = {
  MIN_DELAY_SEC: 180, MAX_DELAY_SEC: 600,
  WINDOW_START_MIN: 510, WINDOW_END_MIN: 1350,
  ALBUM_QUIET_SEC: 20, ALBUM_TTL_SEC: 900,
  REPORT_INTERVAL_SEC: 3600, LOCK_TTL_SEC: 120,
  SEEN_TTL_SEC: 604800, DLQ_TTL_SEC: 2592000,
  MAX_RETRIES: 5, HASH_HISTORY: 500
};

function cfg(env) {
  const n = (name, fb) => { const v = Number(env?.[name]); return Number.isFinite(v) ? v : fb; };
  return {
    source: String(env.SOURCE_CHANNEL_ID || env.SOURCE_CHAT_ID || "4743880175"),
    dest: String(env.DEST_CHANNEL_ID || env.DESTINATION_CHAT_ID || env.TARGET_CHAT_ID || ""),
    destUsername: String(env.DEST_CHANNEL_USERNAME || "yadbegirim"),
    admin: String(env.ADMIN_ID || ""),
    windowOn: String(env.SEND_WINDOW || "on") === "on",
    windowStart: Math.max(0, n("WINDOW_START_MIN", DEFAULTS.WINDOW_START_MIN)),
    windowEnd: Math.max(0, n("WINDOW_END_MIN", DEFAULTS.WINDOW_END_MIN)),
    cleanCaptions: String(env.CLEAN_CAPTIONS || "on") === "on",
    deleteSource: String(env.DELETE_SOURCE || "off") === "on",
    minDelay: Math.max(60, n("MIN_DELAY_SEC", DEFAULTS.MIN_DELAY_SEC)),
    maxDelay: Math.max(60, n("MAX_DELAY_SEC", DEFAULTS.MAX_DELAY_SEC)),
    albumQuiet: Math.max(15, n("ALBUM_QUIET_SEC", DEFAULTS.ALBUM_QUIET_SEC)),
    albumTtl: Math.max(60, n("ALBUM_TTL_SEC", DEFAULTS.ALBUM_TTL_SEC)),
    reportInt: Math.max(3600, n("REPORT_INTERVAL_SEC", DEFAULTS.REPORT_INTERVAL_SEC)),
    lockTtl: Math.max(60, n("LOCK_TTL_SEC", DEFAULTS.LOCK_TTL_SEC)),
    seenTtl: Math.max(60, n("SEEN_TTL_SEC", DEFAULTS.SEEN_TTL_SEC)),
    dlqTtl: Math.max(60, n("DLQ_TTL_SEC", DEFAULTS.DLQ_TTL_SEC)),
    maxRetries: Math.max(1, n("MAX_RETRIES", DEFAULTS.MAX_RETRIES)),
    hashHistory: Math.max(100, n("HASH_HISTORY", DEFAULTS.HASH_HISTORY))
  };
}

function iranMinutes() {
  const d = new Date(Date.now() + 3.5 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function inWindow(c) {
  if (!c.windowOn) return true;
  const m = iranMinutes();
  return m >= c.windowStart && m <= c.windowEnd;
}
function iso(ms = Date.now()) { return new Date(ms).toISOString(); }

/* ============================================================
   CONTENT CLEANING (از V1.9 / V1.10)
============================================================ */
function cleanText(text, entities) {
  if (!text) return "";
  let t = text;
  if (Array.isArray(entities) && entities.length > 0) {
    const sorted = [...entities].sort((a, b) => (b.offset || 0) - (a.offset || 0));
    for (const ent of sorted) {
      if (!ent || ent.offset == null || ent.length == null) continue;
      if (["text_link", "url", "mention"].includes(ent.type)) {
        t = t.substring(0, ent.offset) + t.substring(ent.offset + ent.length);
      }
    }
  }
  const lines = t.split("\n").map(line => {
    let l = line;
    l = l.replace(/https?:\/\/[^\s]+/g, "");
    l = l.replace(/ble\.ir\/[^\s]*/g, "");
    if (/\[.+\]\(.+\)/.test(l)) return "";
    if (/پیشنهاد مجله/.test(l)) return "";
    if (/حتما.+به.+کارت.+میاد/i.test(l)) return "";
    if (/اطلاعات عمومیتو/.test(l)) return "";
    if (/حتــــمـــا/.test(l)) return "";
    l = l.replace(/@\w+/g, "");
    l = l.replace(/[\*]+/g, "");
    l = l.replace(/[➖➕🔻🔸🔹▫️▪️◽◾•●○]/g, "").trim();
    return l.trim();
  });
  return lines.filter(x => x.length > 0).join("\n").trim();
}

function getSmartTags(text) {
  const selected = new Set();
  selected.add(BRANDING_HASHTAG);
  for (const [keyword, tags] of Object.entries(KEYWORD_MAP)) {
    if (text && text.includes(keyword)) tags.forEach(t => selected.add(t));
  }
  if (selected.size === 1) selected.add("#دانستنی");
  return Array.from(selected).slice(0, 3).join(" ");
}

function buildCaption(rawCaption, entities, destUsername) {
  const clean = cleanText(rawCaption || "", entities);
  if (!clean) return null;
  return `${clean}\n\n📌 منبع: @${destUsername}\n\n${getSmartTags(clean)}`;
}

function contentHash(text, fileId) {
  const content = (text || "").slice(0, 100) + (fileId || "");
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h) + content.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

/* ============================================================
   MESSAGE TYPE DETECTION
============================================================ */
function detectType(msg) {
  if (msg.photo && msg.photo.length) return "photo";
  if (msg.video) return "video";
  if (msg.document) return "document";
  if (msg.audio) return "audio";
  if (msg.voice) return "voice";
  if (msg.animation) return "animation";
  if (msg.sticker) return "sticker";
  if (msg.text) return "text";
  return "unknown";
}

function extractFileId(msg, type) {
  if (type === "photo") return msg.photo[msg.photo.length - 1].file_id;
  if (type === "video") return msg.video.file_id;
  if (type === "document") return msg.document.file_id;
  if (type === "audio") return msg.audio.file_id;
  if (type === "voice") return msg.voice.file_id;
  if (type === "animation") return msg.animation.file_id;
  if (type === "sticker") return msg.sticker.file_id;
  return null;
}

/* ============================================================
   KV / API helpers
============================================================ */
async function kvGetJSON(kv, key) {
  try { return await kv.get(key, { type: "json", cacheTtl: 30 }); }
  catch (e) { console.log(JSON.stringify({ event: "KV_GET_ERROR", key, err: e.message })); throw e; }
}
async function kvPutJSON(kv, key, value, ttl) {
  try {
    const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : {};
    await kv.put(key, JSON.stringify(value), opts);
  } catch (e) { console.log(JSON.stringify({ event: "KV_PUT_ERROR", key, err: e.message })); throw e; }
}
async function kvPutText(kv, key, value, ttl) {
  try {
    const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : {};
    await kv.put(key, String(value), opts);
  } catch (e) { console.log(JSON.stringify({ event: "KV_PUT_TEXT_ERROR", key, err: e.message })); throw e; }
}

async function bale(env, method, payload) {
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  if (!token) throw new Error("BALE_BOT_TOKEN missing");
  const res = await fetch(BALE_BASE + token + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok !== true) {
    const e = new Error(`Bale ${method}: ${(data && data.description) || res.status}`);
    e.status = res.status;
    e.retryAfter = data?.parameters?.retry_after || null;
    e.retryable = res.status === 429 || res.status >= 500 || !data;
    throw e;
  }
  return data.result;
}

/* ============================================================
   KV Keys
============================================================ */
const QP = "v17:q:";
const AP = "v17:album:";
const DP = "v17:dlq:";
const HASH_KEY = "v17:hashes";

async function listPrefix(kv, prefix, limit = 1000) {
  const r = await kv.list({ prefix, limit });
  const items = [];
  for (const k of r.keys) {
    const v = await kvGetJSON(kv, k.name);
    if (v) items.push({ key: k.name, item: v });
  }
  return items.sort((a, b) => (a.item.createdAt || 0) - (b.item.createdAt || 0));
}

/* ============================================================
   HASH HISTORY (جلوگیری از تکرار)
============================================================ */
async function checkAndAddHash(kv, c, hash) {
  if (!hash) return false;
  const list = (await kvGetJSON(kv, HASH_KEY)) || [];
  if (list.includes(hash)) return true;
  list.push(hash);
  while (list.length > c.hashHistory) list.shift();
  await kvPutJSON(kv, HASH_KEY, list, 2592000);
  return false;
}

/* ============================================================
   SCHEDULER + LOCK
============================================================ */
async function getSched(kv) {
  return (await kvGetJSON(kv, "v17:sched")) || {
    nextSendAt: 0, lastSendAt: 0, lastReportAt: 0,
    sent: 0, failed: 0, retries: 0, received: 0, lastError: null
  };
}
async function saveSched(kv, s) { await kvPutJSON(kv, "v17:sched", s, 2592000); }

async function acquireLock(kv, c) {
  const existing = await kv.get("v17:lock");
  if (existing) return null;
  const token = crypto.randomUUID();
  await kv.put("v17:lock", token, { expirationTtl: c.lockTtl });
  return (await kv.get("v17:lock")) === token ? token : null;
}
async function releaseLock(kv, token) {
  if (token && (await kv.get("v17:lock")) === token) await kv.delete("v17:lock");
}

async function isDup(kv, c, updateId) {
  if (updateId == null) return false;
  const key = "v17:seen:" + updateId;
  if (await kv.get(key)) return true;
  await kvPutText(kv, key, "1", c.seenTtl);
  return false;
}

/* ============================================================
   SOURCE FILTERING (auto-learn + explicit)
============================================================ */
async function checkSource(kv, c, chatId) {
  // اگر SOURCE_CHANNEL_ID ست شده، فقط از همان
  if (c.source) {
    return String(chatId) === c.source || String(chatId) === "-100" + c.source;
  }
  // auto-learn: اولین کانالی که پست داد، منبع می‌شود
  const learned = await kv.get("v17:learned_source");
  if (!learned) {
    await kv.put("v17:learned_source", String(chatId), { expirationTtl: 2592000 });
    console.log(JSON.stringify({ event: "SOURCE_LEARNED", chatId: String(chatId) }));
    return true;
  }
  return learned === String(chatId);
}

/* ============================================================
   ENQUEUE
============================================================ */
function buildItemFromMessage(msg) {
  const type = detectType(msg);
  const fileId = extractFileId(msg, type);
  const caption = msg.caption || msg.text || "";
  const entities = msg.caption_entities || msg.entities || [];
  const hash = contentHash(caption, fileId);
  return {
    id: `msg-${msg.chat.id}-${msg.message_id}`,
    type,
    sourceChatId: String(msg.chat.id),
    sourceMessageId: Number(msg.message_id),
    fileId,
    caption,
    entities,
    hash,
    createdAt: Date.now(),
    attempts: 0,
    state: "pending",
    retryAt: 0
  };
}

async function enqueueSingle(kv, msg, c) {
  const item = buildItemFromMessage(msg);
  if (await checkAndAddHash(kv, c, item.hash)) {
    console.log(JSON.stringify({ event: "DUPLICATE_CONTENT", hash: item.hash }));
    return { duplicated: true };
  }
  const key = QP + item.createdAt + "-" + crypto.randomUUID().slice(0, 8);
  await kvPutJSON(kv, key, item, c.dlqTtl);
  return { item, key };
}

async function addToAlbum(kv, msg, c) {
  const key = AP + msg.chat.id + ":" + msg.media_group_id;
  let album = (await kvGetJSON(kv, key)) || {
    id: `album-${msg.chat.id}-${msg.media_group_id}`,
    type: "album",
    sourceChatId: String(msg.chat.id),
    mediaGroupId: String(msg.media_group_id),
    items: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const item = buildItemFromMessage(msg);
  if (!album.items.find(x => x.sourceMessageId === item.sourceMessageId)) {
    album.items.push(item);
  }
  album.updatedAt = Date.now();
  await kvPutJSON(kv, key, album, c.albumTtl);
  return album;
}

async function finalizeAlbums(kv, c) {
  const list = await listPrefix(kv, AP, 1000);
  const now = Date.now();
  let finalized = 0;
  for (const { key, item: album } of list) {
    if (now - album.updatedAt < c.albumQuiet * 1000) continue;
    if (!album.items || album.items.length === 0) { await kv.delete(key); continue; }
    const queueItem = {
      id: album.id,
      type: "album",
      sourceChatId: album.sourceChatId,
      mediaGroupId: album.mediaGroupId,
      items: album.items,
      createdAt: album.createdAt,
      attempts: 0, state: "pending", retryAt: 0
    };
    await kvPutJSON(kv, QP + album.createdAt + "-" + crypto.randomUUID().slice(0, 8), queueItem, c.dlqTtl);
    await kv.delete(key);
    finalized++;
  }
  return finalized;
}

/* ============================================================
   SEND (با تمیزکاری کپشن)
============================================================ */
async function sendSingle(env, item) {
  const c = cfg(env);
  const caption = c.cleanCaptions
    ? buildCaption(item.caption, item.entities, c.destUsername)
    : (item.caption || "");

  let method, payload;
  switch (item.type) {
    case "photo":
      method = "sendPhoto";
      payload = { chat_id: c.dest, photo: item.fileId, caption };
      break;
    case "video":
      method = "sendVideo";
      payload = { chat_id: c.dest, video: item.fileId, caption };
      break;
    case "document":
      method = "sendDocument";
      payload = { chat_id: c.dest, document: item.fileId, caption };
      break;
    case "audio":
      method = "sendAudio";
      payload = { chat_id: c.dest, audio: item.fileId, caption };
      break;
    case "voice":
      method = "sendVoice";
      payload = { chat_id: c.dest, voice: item.fileId, caption };
      break;
    case "animation":
      method = "sendAnimation";
      payload = { chat_id: c.dest, animation: item.fileId, caption };
      break;
    case "sticker":
      method = "sendSticker";
      payload = { chat_id: c.dest, sticker: item.fileId };
      break;
    case "text":
    default:
      method = "sendMessage";
      payload = { chat_id: c.dest, text: caption || item.caption || "—" };
  }
  return await bale(env, method, payload);
}

async function sendAlbum(env, item) {
  const c = cfg(env);
  // سعی می‌کنیم با sendMediaGroup ارسال کنیم، در صورت شکست تک‌تک
  const media = item.items.map(sub => {
    const subCaption = c.cleanCaptions
      ? buildCaption(sub.caption, sub.entities, c.destUsername)
      : (sub.caption || "");
    let type = "photo";
    let mediaId = sub.fileId;
    if (sub.type === "video") { type = "video"; }
    else if (sub.type === "document") { type = "document"; }
    else if (sub.type === "audio") { type = "audio"; }
    return { type, media: mediaId, caption: subCaption };
  });
  try {
    return await bale(env, "sendMediaGroup", { chat_id: c.dest, media });
  } catch (e) {
    console.log(JSON.stringify({ event: "ALBUM_FALLBACK", err: e.message }));
    const results = [];
    for (const sub of item.items) {
      try { results.push(await sendSingle(env, sub)); }
      catch (err) { results.push({ error: err.message }); }
    }
    return results;
  }
}

async function deleteSourceMessage(env, item) {
  const c = cfg(env);
  if (!c.deleteSource) return;
  try {
    await bale(env, "deleteMessage", {
      chat_id: item.sourceChatId,
      message_id: item.sourceMessageId
    });
  } catch (e) {
    console.log(JSON.stringify({ event: "DELETE_SOURCE_FAIL", err: e.message }));
  }
}

/* ============================================================
   WEBHOOK
============================================================ */
async function onWebhook(request, env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);
  let body;
  try { body = await request.json(); }
  catch { return new Response("bad json", { status: 400 }); }

  if (await isDup(KV, c, body?.update_id)) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), { headers: { "Content-Type": "application/json" } });
  }

  const msg = body?.channel_post || body?.message;
  if (!msg) return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { "Content-Type": "application/json" } });

  // جلوگیری از لوپ: پست از مقصد را نادیده بگیر
  if (c.dest && String(msg.chat.id) === c.dest) {
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "dest_echo" }), { headers: { "Content-Type": "application/json" } });
  }

  // فیلتر منبع
  if (!(await checkSource(KV, c, msg.chat.id))) {
    console.log(JSON.stringify({ event: "SOURCE_REJECTED", chatId: String(msg.chat.id) }));
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "source" }), { headers: { "Content-Type": "application/json" } });
  }

  const s = await getSched(KV);
  s.received += 1;
  await saveSched(KV, s);

  let resp;
  if (msg.media_group_id) {
    const album = await addToAlbum(KV, msg, c);
    resp = { ok: true, queued: "album_collecting", items: album.items.length };
    console.log(JSON.stringify({ event: "ALBUM_RECEIVED", chatId: String(msg.chat.id), groupId: msg.media_group_id, mid: msg.message_id }));
  } else {
    const result = await enqueueSingle(KV, msg, c);
    if (result.duplicated) {
      resp = { ok: true, ignored: true, reason: "duplicate" };
    } else {
      resp = { ok: true, queued: result.item.type };
      console.log(JSON.stringify({ event: "MESSAGE_QUEUED", type: result.item.type, hash: result.item.hash, mid: msg.message_id }));
    }
  }
  return new Response(JSON.stringify(resp), { headers: { "Content-Type": "application/json" } });
}

/* ============================================================
   PROCESS ONE QUEUE ITEM
============================================================ */
function backoffSeconds(attempt, retryAfter) {
  if (retryAfter > 0) return Math.max(60, retryAfter);
  const delays = [60, 120, 240, 480, 900];
  return delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)];
}

async function processOne(env, kv, c) {
  const queue = await listPrefix(kv, QP, 1000);
  if (queue.length === 0) return { status: "empty" };
  const now = Date.now();
  const candidate = queue.find(({ item }) =>
    item.state === "pending" || (item.state === "retry" && (item.retryAt || 0) <= now)
  );
  if (!candidate) return { status: "none_ready" };

  const { key, item } = candidate;
  item.state = "processing";
  item.attempts += 1;
  await kvPutJSON(kv, key, item, c.dlqTtl);

  try {
    if (item.type === "album") {
      await sendAlbum(env, item);
      if (c.deleteSource) {
        for (const sub of item.items) await deleteSourceMessage(env, sub);
      }
    } else {
      await sendSingle(env, item);
      await deleteSourceMessage(env, item);
    }
    await kv.delete(key);
    console.log(JSON.stringify({ event: "SEND_SUCCESS", id: item.id, type: item.type }));
    return { status: "sent" };
  } catch (e) {
    item.lastError = e.message || String(e);
    if (item.attempts >= c.maxRetries) {
      await kvPutJSON(kv, DP + item.id, { ...item, failedAt: now }, c.dlqTtl);
      await kv.delete(key);
      console.log(JSON.stringify({ event: "MOVED_TO_DLQ", id: item.id, err: item.lastError }));
      return { status: "dlq", error: item.lastError };
    }
    item.state = "retry";
    item.retryAt = now + backoffSeconds(item.attempts, e.retryAfter || 0) * 1000;
    await kvPutJSON(kv, key, item, c.dlqTtl);
    console.log(JSON.stringify({ event: "RETRY_SCHEDULED", id: item.id, attempt: item.attempts, err: item.lastError }));
    return { status: "retry", error: item.lastError };
  }
}

/* ============================================================
   CRON
============================================================ */
async function onCron(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);

  try { await finalizeAlbums(KV, c); } catch (e) { console.log(JSON.stringify({ event: "ALBUM_FINALIZE_ERROR", err: e.message })); }

  const lockToken = await acquireLock(KV, c);
  if (!lockToken) { console.log(JSON.stringify({ event: "CRON_SKIPPED_LOCKED" })); return; }

  try {
    const s = await getSched(KV);
    const now = Date.now();

    // گزارش ساعتی
    if (c.admin && now - (s.lastReportAt || 0) >= c.reportInt * 1000) {
      const q = await listPrefix(KV, QP, 1000);
      const d = await listPrefix(KV, DP, 100);
      const txt = `📊 گزارش mynote_bot (V17)\n\n🕐 ${iso()}\n⏰ بازه ارسال: ${String(Math.floor(c.windowStart/60)).padStart(2,"0")}:${String(c.windowStart%60).padStart(2,"0")} تا ${String(Math.floor(c.windowEnd/60)).padStart(2,"0")}:${String(c.windowEnd%60).padStart(2,"0")}\n\n📥 دریافتی: ${s.received}\n📤 ارسال موفق: ${s.sent}\n🔁 Retry: ${s.retries}\n☠️ DLQ: ${d.length}\n❌ Failed: ${s.failed}\n📦 صف: ${q.length}\n⏭ ارسال بعدی: ${s.nextSendAt ? iso(s.nextSendAt) : "—"}\n\n${s.lastError ? "⚠️ خطا: " + s.lastError : "✅ بدون خطا"}`;
      try {
        await bale(env, "sendMessage", { chat_id: c.admin, text: txt });
        s.lastReportAt = now;
        await saveSched(KV, s);
      } catch (e) { console.log(JSON.stringify({ event: "REPORT_ERROR", err: e.message })); }
    }

    // خارج از پنجره؟
    if (!inWindow(c)) {
      console.log(JSON.stringify({ event: "OUTSIDE_WINDOW", currentMins: iranMinutes() }));
      return;
    }

    const queue = await listPrefix(KV, QP, 1000);
    if (queue.length === 0) {
      s.nextSendAt = 0;
      await saveSched(KV, s);
      return;
    }

    // اولین ارسال: زمان‌بندی تصادفی
    if (!s.nextSendAt || s.nextSendAt <= 0) {
      const delay = Math.floor(c.minDelay + Math.random() * (c.maxDelay - c.minDelay + 1));
      s.nextSendAt = now + delay * 1000;
      await saveSched(KV, s);
      console.log(JSON.stringify({ event: "NEXT_SEND_SCHEDULED", delay, nextSendAt: iso(s.nextSendAt) }));
      return;
    }

    // هنوز وقت نرسیده
    if (now < s.nextSendAt) {
      return;
    }

    // ارسال یکی
    const r = await processOne(env, KV, c);
    if (r.status === "sent") {
      s.sent += 1;
      const delay = Math.floor(c.minDelay + Math.random() * (c.maxDelay - c.minDelay + 1));
      s.nextSendAt = now + delay * 1000;
      s.lastError = null;
    } else if (r.status === "retry") {
      s.retries += 1;
      s.lastError = r.error;
    } else if (r.status === "dlq") {
      s.failed += 1;
      s.lastError = r.error;
      const delay = Math.floor(c.minDelay + Math.random() * (c.maxDelay - c.minDelay + 1));
      s.nextSendAt = now + delay * 1000;
    }
    await saveSched(KV, s);
  } finally {
    await releaseLock(KV, lockToken);
  }
}

/* ============================================================
   ADMIN
============================================================ */
function isAdmin(req, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const auth = req.headers.get("Authorization");
  if (auth === `Bearer ${key}`) return true;
  return new URL(req.url).searchParams.get("key") === key;
}
async function adminStatus(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);
  const s = await getSched(KV);
  const q = await listPrefix(KV, QP, 1000);
  const d = await listPrefix(KV, DP, 100);
  const a = await listPrefix(KV, AP, 1000);
  const hashes = (await kvGetJSON(KV, HASH_KEY)) || [];
  return {
    version: VERSION,
    config: {
      source: c.source, dest: c.dest, destUsername: c.destUsername,
      windowOn: c.windowOn, window: `${c.windowStart}-${c.windowEnd}`,
      cleanCaptions: c.cleanCaptions, deleteSource: c.deleteSource,
      delay: `${c.minDelay}-${c.maxDelay}s`
    },
    scheduler: s,
    queue: q.length, albums: a.length, dlq: d.length,
    hashHistory: hashes.length,
    time: iso()
  };
}
async function adminReset(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const s = await getSched(KV);
  s.nextSendAt = 0; s.lastError = null;
  await saveSched(KV, s);
  return { ok: true };
}
async function adminRequeueDLQ(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);
  const list = await listPrefix(KV, DP, 1000);
  let count = 0;
  for (const { key, item } of list) {
    item.state = "pending"; item.attempts = 0; item.retryAt = 0;
    await kvPutJSON(KV, QP + item.createdAt + "-" + crypto.randomUUID().slice(0, 8), item, c.dlqTtl);
    await KV.delete(key); count++;
  }
  return { ok: true, requeued: count };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p === "/webhook" || p === "/telegram/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      try { return await onWebhook(request, env); }
      catch (e) { console.log(JSON.stringify({ event: "WEBHOOK_ERROR", err: e.message })); return json({ ok: false, error: e.message }, 500); }
    }
    if (p === "/health") return json({ ok: true, version: VERSION });
    if (p === "/admin/status") return isAdmin(request, env) ? json(await adminStatus(env)) : new Response("Unauthorized", { status: 401 });
    if (p === "/admin/reset") return isAdmin(request, env) ? json(await adminReset(env)) : new Response("Unauthorized", { status: 401 });
    if (p === "/admin/requeue-dlq") return isAdmin(request, env) ? json(await adminRequeueDLQ(env)) : new Response("Unauthorized", { status: 401 });
    if (p === "/") {
      const KV = env.MYNOTE_KV || env.KV;
      const s = KV ? await getSched(KV) : {};
      return json({ ok: true, service: "mynote_bot", version: VERSION, stats: s });
    }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(controller, env) {
    try { await onCron(env); }
    catch (e) { console.log(JSON.stringify({ event: "CRON_FATAL", err: e.message, stack: e.stack })); }
  }
};