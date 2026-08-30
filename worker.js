const VERSION = "V34-POLL-2026-08-30";
const BALE_BASE = "https://tapi.bale.ai/bot";
const BALE_FILE_BASE = "https://tapi.bale.ai/file";
const STATE_KEY = "mynote:state26";
const QLOCK_KEY = "mynote:qlock26";
const MIG_KEY = "mynote:migrated26";
const POLL_OFFSET_KEY = "mynote:poll_offset";
const HASHTAG_BANK_KEY = "mynote:hashtag_bank";
const TAG_STATE_PREFIX = "mynote:tag_state:";
const CLEAN_RULES_KEY = "mynote:cleaning_rules";

const KV_LIMITS = { write: 1000, read: 100000, list: 1000 };
let USAGE = { w: 0, r: 0, l: 0 };
function count(op) { if (op === "w") USAGE.w++; else if (op === "r") USAGE.r++; else USAGE.l++; }

const DEFAULTS = {
  MIN_DELAY_SEC: 180, MAX_DELAY_SEC: 600,
  WINDOW_START_MIN: 510, WINDOW_END_MIN: 1350,
  ALBUM_QUIET_SEC: 20, REPORT_INTERVAL_SEC: 10800,
  DLQ_TTL_SEC: 2592000, MAX_RETRIES: 5, HASH_HISTORY: 2000
};

const DEFAULT_BANK = {
  branding: "#یادبگیریم", fallback: "#دانستنی",
  keywords: {
    'غذا': ['#تغذیه'], 'کیوی': ['#سلامتی'], 'سیگار': ['#سلامتی'],
    'تاریخ': ['#تاریخ'], 'ایران': ['#ایران'], 'کوروش': ['#تاریخ'],
    'دریاچه': ['#رازهای_طبیعت'], 'گنج': ['#شاه_کلید'], 'افسانه': ['#حقایق_جالب'],
    'ترفند': ['#ترفند'], 'زندگی': ['#ترفند_زندگی'], 'معما': ['#معما'],
    'طبیعت': ['#رازهای_طبیعت'], 'خلاق': ['#خلاقیت'], 'دانستنی': ['#دانستنی'],
    'ارگ': ['#تاریخ'], 'علیشاه': ['#تاریخ'], 'تبریز': ['#ایران'],
    'مسجد': ['#تاریخ'], 'معماری': ['#هنر'], 'کاشی': ['#هنر'],
    'الماس': ['#اقتصاد'], 'ماشین': ['#اقتصاد'], 'هواپیما': ['#تکنولوژی'],
    'آمازون': ['#دانستنی'], 'عکس': ['#هنر'], 'مغز': ['#دانستنی'],
    'ورزش': ['#سلامتی'], 'کتاب': ['#دانستنی'], 'پسته': ['#تغذیه'],
    'قلب': ['#سلامتی'], 'فشار خون': ['#سلامتی'], 'کلسترول': ['#سلامتی']
  }
};

const T_HASHTAG = "🏷️ هشتگ", T_ADD = "➕ افزودن", T_DEL = "🗑️ حذف",
      T_LIST = "📋 لیست", T_TEST = "🔍 تست", T_CANCEL = "❌ لغو";
const MENUS = {
  home: { text: "🛠️ منوی مدیریت", rows: [[T_HASHTAG]] },
  hashtag: { text: "🏷️ مدیریت هشتگ", rows: [[T_ADD, T_DEL], [T_LIST, T_TEST], [T_CANCEL]] }
};

function cfg(env) {
  const n = (name, fb) => { const v = Number(env?.[name]); return Number.isFinite(v) ? v : fb; };
  return {
    source: String(env.SOURCE_CHANNEL_ID || env.SOURCE_CHAT_ID || ""),
    dest: String(env.DEST_CHANNEL_ID || env.DESTINATION_CHAT_ID || env.TARGET_CHAT_ID || ""),
    destUsername: String(env.DEST_CHANNEL_USERNAME || "yadbegirim"),
    admin: String(env.ADMIN_ID || ""),
    windowOn: String(env.SEND_WINDOW || "on") === "on",
    windowStart: Math.max(0, n("WINDOW_START_MIN", DEFAULTS.WINDOW_START_MIN)),
    windowEnd: Math.max(0, n("WINDOW_END_MIN", DEFAULTS.WINDOW_END_MIN)),
    cleanCaptions: String(env.CLEAN_CAPTIONS || "on") === "on",
    deleteSource: String(env.DELETE_SOURCE || "off") === "on",
    acceptEdits: String(env.ACCEPT_EDITS || "off") === "on",
    minDelay: Math.max(60, n("MIN_DELAY_SEC", DEFAULTS.MIN_DELAY_SEC)),
    maxDelay: Math.max(60, n("MAX_DELAY_SEC", DEFAULTS.MAX_DELAY_SEC)),
    albumQuiet: Math.max(15, n("ALBUM_QUIET_SEC", DEFAULTS.ALBUM_QUIET_SEC)),
    reportInt: Math.max(3600, n("REPORT_INTERVAL_SEC", DEFAULTS.REPORT_INTERVAL_SEC)),
    maxRetries: Math.max(1, n("MAX_RETRIES", DEFAULTS.MAX_RETRIES)),
    hashHistory: Math.max(100, n("HASH_HISTORY", DEFAULTS.HASH_HISTORY))
  };
}
function iranMinutes() { const d = new Date(Date.now() + 3.5 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function inWindow(c) { if (!c.windowOn) return true; const m = iranMinutes(); return m >= c.windowStart && m <= c.windowEnd; }
function iso(ms) { return new Date(ms || Date.now()).toISOString(); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function normalizeText(t) { return (t || "").replace(/\u0640+/g, "").replace(/ك/g, "ک").replace(/ي/g, "ی").replace(/\s+/g, " ").trim(); }

function cleanText(text, entities) {
  if (!text) return "";
  let t = text;
  if (Array.isArray(entities) && entities.length > 0) {
    const sorted = [...entities].sort((a, b) => (b.offset || 0) - (a.offset || 0));
    for (const ent of sorted) {
      if (!ent || ent.offset == null || ent.length == null) continue;
      if (["text_link", "url", "mention"].includes(ent.type)) t = t.substring(0, ent.offset) + t.substring(ent.offset + ent.length);
    }
  }
  const lines = t.split("\n").map(function (line) {
    let l = line;
    l = l.replace(/\u0640+/g, "").replace(/\[[^\]]*\]\([^)]*\)?/g, "");
    l = l.replace(/https?:\/\/[^\s]+/g, "").replace(/ble\.ir\/[^\s]*/g, "").replace(/t\.me\/[^\s]*/g, "");
    l = l.replace(/@[a-zA-Z0-9_]+/g, "").replace(/#[^\s]+/g, "").replace(/[\*]+/g, "");
    l = l.replace(/\uFFFD/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
    l = l.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").replace(/[\u200B\u200D\uFE0F]/g, "");
    const n = l.trim();
    if (!n || /^[\s\u200C]*$/.test(n)) return "";
    if (!/[\p{L}\p{N}]/u.test(n) && /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(n)) return "";
    if (/دانستنی\s*های\s*جالب/.test(n)) return "";
    if (/پیشنهاد مجله/.test(n)) return "";
    if (/حتما.{0,25}کارت.{0,25}میاد/.test(n)) return "";
    if (/اطلاعات عمومیت/.test(n)) return "";
    if (/^join/i.test(n)) return "";
    if (/عضو\s*شو/.test(n)) return "";
    if (/کانال ما/.test(n)) return "";
    return n;
  });
  return lines.filter(function (x) { return x.length > 0; }).join("\n").trim();
}

async function loadHashtagBank(kv) {
  try {
    count("r"); const bank = await kv.get(HASHTAG_BANK_KEY, "json");
    if (bank && bank.keywords) return { branding: bank.branding || DEFAULT_BANK.branding, fallback: bank.fallback || DEFAULT_BANK.fallback, keywords: bank.keywords };
  } catch (e) { }
  return { branding: DEFAULT_BANK.branding, fallback: DEFAULT_BANK.fallback, keywords: Object.assign({}, DEFAULT_BANK.keywords) };
}
async function saveHashtagBank(kv, bank) { await kvPutJSON(kv, HASHTAG_BANK_KEY, bank, 2592000); }
async function getSmartTags(kv, text) {
  const bank = await loadHashtagBank(kv);
  const selected = new Set(); selected.add(bank.branding);
  const normalized = normalizeText(text || "");
  for (const entry of Object.entries(bank.keywords)) {
    if (entry[0] && normalized.includes(normalizeText(entry[0])))
      (Array.isArray(entry[1]) ? entry[1] : [entry[1]]).forEach(function (t) { selected.add(t); });
  }
  if (selected.size === 1) selected.add(bank.fallback);
  return Array.from(selected).slice(0, 3).join(" ");
}
async function buildCaption(kv, rawCaption, entities, destUsername) {
  const clean = cleanText(rawCaption || "", entities);
  if (!clean) return null;
  return clean + "\n\n📌 منبع: @" + destUsername + "\n\n" + (await getSmartTags(kv, clean));
}
async function loadCleaningRules(kv) {
  try { count("r"); return (await kv.get(CLEAN_RULES_KEY, "json")) || { forbidden_phrases: [], forbidden_regex: [], replace_rules: [], remove_emojis: [], remove_lines: [] }; }
  catch (e) { return { forbidden_phrases: [], forbidden_regex: [], replace_rules: [], remove_emojis: [], remove_lines: [] }; }
}
async function applyCustomRules(kv, text) {
  if (!text) return text;
  const rules = await loadCleaningRules(kv);
  let lines = text.split("\n");
  for (const phrase of rules.forbidden_phrases || []) { if (!phrase) continue; lines = lines.map(function (l) { return l.split(phrase).join(""); }); }
  for (const pattern of rules.remove_lines || []) { if (!pattern) continue; lines = lines.filter(function (l) { return !l.includes(pattern); }); }
  for (const rx of rules.forbidden_regex || []) { if (!rx) continue; try { const re = new RegExp(rx, "gi"); lines = lines.map(function (l) { return l.replace(re, ""); }); } catch (e) { } }
  for (const rule of rules.replace_rules || []) { if (!rule || !rule.from) continue; lines = lines.map(function (l) { return l.split(rule.from).join(rule.to || ""); }); }
  for (const emoji of rules.remove_emojis || []) { if (!emoji) continue; lines = lines.map(function (l) { return l.split(emoji).join(""); }); }
  return lines.map(function (l) { return l.trim(); }).filter(function (x) { return x.length > 0; }).join("\n").trim();
}

function contentHash(text, fileId) {
  const content = normalizeText(text || "").slice(0, 150) + "|" + (fileId || "");
  let h = 0;
  for (let i = 0; i < content.length; i++) { h = ((h << 5) - h) + content.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}
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
function extractFileName(msg, type) {
  if (type === "video") return msg.video.file_name;
  if (type === "document") return msg.document.file_name;
  if (type === "audio") return msg.audio.file_name || msg.audio.title;
  if (type === "animation") return msg.animation.file_name;
  return null;
}
function extractMimeType(msg, type) {
  if (type === "video") return msg.video.mime_type;
  if (type === "document") return msg.document.mime_type;
  if (type === "audio") return msg.audio.mime_type;
  if (type === "voice") return msg.voice.mime_type;
  if (type === "animation") return msg.animation.mime_type;
  if (type === "sticker") return "image/webp";
  return null;
}

async function kvGetJSON(kv, key) {
  try { count("r"); return await kv.get(key, { type: "json", cacheTtl: 30 }); }
  catch (e) { throw e; }
}
async function kvPutJSON(kv, key, value, ttl) {
  try {
    const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : {};
    count("w"); await kv.put(key, JSON.stringify(value), opts);
    return true;
  } catch (e) {
    const msg = String(e && e.message || "");
    if (msg.includes("limit exceeded")) { console.log(JSON.stringify({ event: "KV_QUOTA_EXCEEDED", key: key })); return false; }
    console.log(JSON.stringify({ event: "KV_PUT_ERROR", key: key, err: msg }));
    return false;
  }
}
async function kvDeleteSafe(kv, key) { try { count("w"); await kv.delete(key); } catch (e) { } }

async function bale(env, method, payload) {
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  if (!token) throw new Error("BALE_BOT_TOKEN missing");
  const res = await fetch(BALE_BASE + token + "/" + method, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || data.ok !== true) {
    const e = new Error("Bale " + method + ": " + ((data && data.description) || res.status));
    e.status = res.status;
    e.retryAfter = data && data.parameters ? data.parameters.retry_after : null;
    throw e;
  }
  return data.result;
}

async function downloadFileBuffer(env, fileId) {
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  const fileInfo = await bale(env, "getFile", { file_id: fileId });
  if (!fileInfo || !fileInfo.file_path) throw new Error("getFile returned no path");
  const res = await fetch(BALE_FILE_BASE + "/bot" + token + "/" + fileInfo.file_path);
  if (!res.ok) throw new Error("Download failed: " + res.status);
  return { buffer: await res.arrayBuffer(), fileName: fileInfo.file_path.split("/").pop() };
}
async function sendWithUpload(env, method, field, dest, fileId, caption, fileName, mimeType) {
  const { buffer } = await downloadFileBuffer(env, fileId);
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  const form = new FormData();
  form.append("chat_id", dest);
  const blob = new Blob([buffer], { type: mimeType || "application/octet-stream" });
  form.append(field, blob, fileName || "file");
  if (caption) form.append("caption", caption);
  const res = await fetch(BALE_BASE + token + "/" + method, { method: "POST", body: form });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || data.ok !== true) throw new Error("Upload " + method + ": " + ((data && data.description) || res.status));
  return data.result;
}
async function sendPhotoSmart(env, dest, fileId, caption) {
  try { return await bale(env, "sendPhoto", { chat_id: dest, photo: fileId, caption: caption || undefined }); }
  catch (e) {
    console.log(JSON.stringify({ event: "PHOTO_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendPhoto", "photo", dest, fileId, caption, "photo.jpg", "image/jpeg");
  }
}
async function sendVideoSmart(env, dest, fileId, caption, fileName) {
  try { return await bale(env, "sendVideo", { chat_id: dest, video: fileId, caption: caption || undefined }); }
  catch (e) {
    console.log(JSON.stringify({ event: "VIDEO_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendVideo", "video", dest, fileId, caption, fileName || "video.mp4", "video/mp4");
  }
}
async function sendDocumentSmart(env, dest, fileId, caption, fileName, mimeType) {
  try { return await bale(env, "sendDocument", { chat_id: dest, document: fileId, caption: caption || undefined }); }
  catch (e) {
    console.log(JSON.stringify({ event: "DOC_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendDocument", "document", dest, fileId, caption, fileName || "file", mimeType || "application/octet-stream");
  }
}
async function sendAudioSmart(env, dest, fileId, caption, fileName) {
  try { return await bale(env, "sendAudio", { chat_id: dest, audio: fileId, caption: caption || undefined }); }
  catch (e) {
    console.log(JSON.stringify({ event: "AUDIO_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendAudio", "audio", dest, fileId, caption, fileName || "audio.mp3", "audio/mpeg");
  }
}
async function sendVoiceSmart(env, dest, fileId, caption) {
  try { return await bale(env, "sendVoice", { chat_id: dest, voice: fileId, caption: caption || undefined }); }
  catch (e) {
    console.log(JSON.stringify({ event: "VOICE_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendVoice", "voice", dest, fileId, caption, "voice.ogg", "audio/ogg");
  }
}
async function sendAnimationSmart(env, dest, fileId, caption) {
  try { return await bale(env, "sendAnimation", { chat_id: dest, animation: fileId, caption: caption || undefined }); }
  catch (e) {
    console.log(JSON.stringify({ event: "ANIM_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendAnimation", "animation", dest, fileId, caption, "animation.mp4", "video/mp4");
  }
}
async function sendStickerSmart(env, dest, fileId) {
  try { return await bale(env, "sendSticker", { chat_id: dest, sticker: fileId }); }
  catch (e) {
    console.log(JSON.stringify({ event: "STICKER_FALLBACK_UPLOAD", fileId: fileId, err: String(e.message) }));
    return await sendWithUpload(env, "sendSticker", "sticker", dest, fileId, null, "sticker.webp", "image/webp");
  }
}

function emptyState() {
  return { items: [], albums: {}, dlq: [], hashes: [], usage: null, sched: { nextSendAt: 0, lastSendAt: 0, lastReportAt: 0, sent: 0, failed: 0, retries: 0, received: 0, ignored: 0, lastError: null, lastIgnoreReason: null } };
}
async function readState(kv) { return (await kvGetJSON(kv, STATE_KEY)) || emptyState(); }

function readUsage(st) {
  const today = new Date().toISOString().slice(0, 10);
  if (!st.usage || st.usage.day !== today) return { day: today, w: 0, r: 0, l: 0 };
  return st.usage;
}

function flushUsage(st) {
  const today = new Date().toISOString().slice(0, 10);
  if (!st.usage || st.usage.day !== today) st.usage = { day: today, w: 0, r: 0, l: 0 };
  st.usage.w += USAGE.w; st.usage.r += USAGE.r; st.usage.l += USAGE.l;
  USAGE = { w: 0, r: 0, l: 0 };
}
function quotaText(st) {
  const u = readUsage(st);
  const wr = KV_LIMITS.write - u.w, rr = KV_LIMITS.read - u.r, lr = KV_LIMITS.list - u.l;
  let t = "💾 سهمیهٔ KV امروز\n✍️ نوشتن: " + u.w + "/" + KV_LIMITS.write + " (مانده " + wr + ")\n📖 خواندن: " + u.r + "/" + KV_LIMITS.read + " (مانده " + rr + ")\n📋 list: " + u.l + "/" + KV_LIMITS.list + " (مانده " + lr + ")";
  if (wr < 200) t += "\n⚠️ سهمیهٔ نوشتن رو به اتمام است!";
  return t;
}

async function tryLock(kv, key, tries, waitMs) {
  for (let i = 0; i < tries; i++) {
    try {
      count("r"); const existing = await kv.get(key);
      if (!existing) {
        const token = crypto.randomUUID();
        count("w"); await kv.put(key, token, { expirationTtl: 60 });
        count("r"); const conf = await kv.get(key);
        if (conf === token) return token;
      }
    } catch (e) {
      const msg = String(e && e.message || "");
      if (msg.includes("limit exceeded")) { console.log(JSON.stringify({ event: "LOCK_QUOTA_SKIP" })); return "NOLOCK"; }
    }
    if (i < tries - 1) await sleep(waitMs);
  }
  return null;
}
async function unlock(kv, key, token) {
  if (!token || token === "NOLOCK") return;
  count("r"); if ((await kv.get(key)) === token) await kvDeleteSafe(kv, key);
}
async function withState(kv, mutate) {
  const token = await tryLock(kv, QLOCK_KEY, 12, 100);
  try {
    const st = await readState(kv);
    const out = mutate(st) || {};
    flushUsage(st);
    await kvPutJSON(kv, STATE_KEY, st, 2592000);
    return out;
  } finally {
    await unlock(kv, QLOCK_KEY, token);
  }
}

async function migrate(kv) {
  if (await kvGetJSON(kv, MIG_KEY)) return;
  try {
    const oldQueue = (await kvGetJSON(kv, "mynote:queue")) || [];
    const oldDlq = (await kvGetJSON(kv, "mynote:dlq")) || [];
    const oldAlbums = (await kvGetJSON(kv, "mynote:albums")) || {};
    const oldHashes = (await kvGetJSON(kv, "mynote:hashes")) || [];
    const oldSched = (await kvGetJSON(kv, "mynote:sched")) || null;
    const oldState24 = (await kvGetJSON(kv, "mynote:state24")) || null;
    const oldState25 = (await kvGetJSON(kv, "mynote:state25")) || null;
    await withState(kv, function (st) {
      const sources = [oldState24, oldState25];
      for (const src of sources) {
        if (!src) continue;
        for (const it of (src.items || [])) { if (!st.items.some(function (x) { return x.id === it.id; })) st.items.push(it); }
        for (const it of (src.dlq || [])) st.dlq.push(it);
        for (const h of (src.hashes || [])) { if (!st.hashes.includes(h)) st.hashes.push(h); }
        Object.assign(st.albums, src.albums || {});
        if (src.sched) Object.assign(st.sched, src.sched);
      }
      for (const it of oldQueue) { if (!st.items.some(function (x) { return x.id === it.id; })) st.items.push(it); }
      for (const it of oldDlq) st.dlq.push(it);
      for (const mgid of Object.keys(oldAlbums)) {
        const a = oldAlbums[mgid];
        if (a && a.items && a.items.length) st.items.push({ id: a.id, type: "album", sourceChatId: a.sourceChatId, mediaGroupId: a.mediaGroupId, items: a.items, createdAt: Date.now(), attempts: 0, state: "pending", retryAt: 0 });
      }
      for (const h of oldHashes) { if (!st.hashes.includes(h)) st.hashes.push(h); }
      if (oldSched) Object.assign(st.sched, oldSched);
      return {};
    });
    await kvDeleteSafe(kv, "mynote:queue"); await kvDeleteSafe(kv, "mynote:dlq");
    await kvDeleteSafe(kv, "mynote:albums"); await kvDeleteSafe(kv, "mynote:sched");
    await kvDeleteSafe(kv, "mynote:state24"); await kvDeleteSafe(kv, "mynote:state25");
    await kvDeleteSafe(kv, "mynote:last_webhook");
    console.log(JSON.stringify({ event: "MIGRATED_TO_V34" }));
  } catch (e) { console.log(JSON.stringify({ event: "MIGRATE_ERROR", err: e.message })); }
  await kvPutJSON(kv, MIG_KEY, { at: Date.now() }, 2592000);
}

function buildItemFromMessage(msg) {
  const type = detectType(msg);
  const fileId = extractFileId(msg, type);
  const caption = msg.caption || msg.text || "";
  const entities = msg.caption_entities || msg.entities || [];
  return {
    id: "msg-" + msg.chat.id + "-" + msg.message_id,
    type: type, sourceChatId: String(msg.chat.id), sourceMessageId: Number(msg.message_id),
    fileId: fileId, caption: caption, entities: entities,
    fileName: extractFileName(msg, type), mimeType: extractMimeType(msg, type),
    hash: contentHash(caption, fileId),
    createdAt: Date.now(), attempts: 0, state: "pending", retryAt: 0
  };
}
async function makeCaption(env, kv, item) {
  const c = cfg(env);
  let caption = item.caption || "";
  if (c.cleanCaptions) {
    caption = (await buildCaption(kv, item.caption, item.entities, c.destUsername)) || "";
    caption = await applyCustomRules(kv, caption);
  }
  return caption;
}

/* 🎯 sendSingle با ۴ پله: smart send → upload → copyMessage → forwardMessage */
async function sendSingle(env, item) {
  const c = cfg(env);
  const kv = env.MYNOTE_KV || env.KV;
  const caption = await makeCaption(env, kv, item);
  try {
    switch (item.type) {
      case "photo": return await sendPhotoSmart(env, c.dest, item.fileId, caption);
      case "video": return await sendVideoSmart(env, c.dest, item.fileId, caption, item.fileName);
      case "document": return await sendDocumentSmart(env, c.dest, item.fileId, caption, item.fileName, item.mimeType);
      case "audio": return await sendAudioSmart(env, c.dest, item.fileId, caption, item.fileName);
      case "voice": return await sendVoiceSmart(env, c.dest, item.fileId, caption);
      case "animation": return await sendAnimationSmart(env, c.dest, item.fileId, caption);
      case "sticker": return await sendStickerSmart(env, c.dest, item.fileId);
      default: return await bale(env, "sendMessage", { chat_id: c.dest, text: caption || item.caption || "—" });
    }
  } catch (e) {
    if (item.type !== "text" && item.sourceMessageId) {
      console.log(JSON.stringify({ event: "COPY_FALLBACK", id: item.id, err: String(e.message) }));
      try {
        return await bale(env, "copyMessage", { chat_id: c.dest, from_chat_id: item.sourceChatId, message_id: item.sourceMessageId });
      } catch (e2) {
        console.log(JSON.stringify({ event: "FORWARD_FALLBACK", id: item.id, err: String(e2.message) }));
        return await bale(env, "forwardMessage", { chat_id: c.dest, from_chat_id: item.sourceChatId, message_id: item.sourceMessageId });
      }
    }
    throw e;
  }
}
async function sendAlbum(env, item) {
  const c = cfg(env);
  const kv = env.MYNOTE_KV || env.KV;
  const media = [];
  for (const sub of item.items) {
    const cap = await makeCaption(env, kv, sub);
    let type = "photo";
    if (sub.type === "video") type = "video";
    else if (sub.type === "document") type = "document";
    else if (sub.type === "audio") type = "audio";
    media.push({ type: type, media: sub.fileId, caption: cap || undefined });
  }
  try { return await bale(env, "sendMediaGroup", { chat_id: c.dest, media: media }); }
  catch (e) {
    console.log(JSON.stringify({ event: "ALBUM_FALLBACK_SINGLE", err: e.message }));
    let n = 0;
    for (const sub of item.items) { await sendSingle(env, sub); n++; }
    if (n === 0) throw e;
    return { partial: true };
  }
}
async function deleteSourceMessage(env, item) {
  const c = cfg(env);
  if (!c.deleteSource) return;
  try { await bale(env, "deleteMessage", { chat_id: item.sourceChatId, message_id: item.sourceMessageId }); }
  catch (e) { }
}

async function getState2(kv, chatId) { try { count("r"); return await kv.get(TAG_STATE_PREFIX + chatId, "json"); } catch (e) { return null; } }
async function setState2(kv, chatId, state) { if (!state) { await kvDeleteSafe(kv, TAG_STATE_PREFIX + chatId); return; } await kvPutJSON(kv, TAG_STATE_PREFIX + chatId, state, 3600); }
function makeKeyboard(rows) { return { keyboard: rows, resize_keyboard: true }; }
async function adminSay(env, chatId, text, rows) {
  const payload = { chat_id: chatId, text: text };
  if (rows) payload.reply_markup = makeKeyboard(rows);
  try { await bale(env, "sendMessage", payload); } catch (e) { }
}
function parseAddInput(text) {
  const out = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[") || line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const obj of arr) {
          if (obj && obj.keyword) {
            const tags = Array.isArray(obj.tags) ? obj.tags : (obj.tag ? [obj.tag] : []);
            if (tags.length) out.push({ keyword: normalizeText(obj.keyword), tags: tags.map(function (t) { return String(t).startsWith("#") ? t : "#" + t; }) });
          }
        }
        continue;
      } catch (e) { }
    }
    if (!line.includes("#")) continue;
    const tags = line.match(/#[^\s#]+/g) || [];
    const keyword = normalizeText(line.slice(0, line.indexOf("#")).replace(/[=:：]\s*$/, ""));
    if (keyword && tags.length) out.push({ keyword: keyword, tags: tags });
  }
  return out;
}

async function handleTagAdmin(env, kv, c, msg) {
  const text = (msg.text || "").trim();
  const chatId = String(msg.chat.id);
  if (text === "/start" || text === "/menu" || text === "/tags") { await setState2(kv, chatId, null); await adminSay(env, chatId, MENUS.home.text, MENUS.home.rows); return true; }
  if (text === "/status" || text === "/admin") {
    const st = await readState(kv);
    const bank = await loadHashtagBank(kv);
    const txt = "📊 وضعیت بات (V34)\n\n📥 دریافتی: " + st.sched.received + "\n📤 ارسال موفق: " + st.sched.sent + "\n🔁 Retry: " + st.sched.retries + "\n☠️ DLQ: " + st.dlq.length + "\n📦 صف: " + st.items.length + "\n🏷️ هشتگ‌ها: " + Object.keys(bank.keywords).length + "\n⏭ ارسال بعدی: " + (st.sched.nextSendAt ? iso(st.sched.nextSendAt) : "—") + "\n\n" + quotaText(st) + "\n\n" + (st.sched.lastError ? "⚠️ خطا: " + st.sched.lastError : "✅ بدون خطا");
    await adminSay(env, chatId, txt, MENUS.home.rows);
    return true;
  }
  if (text === T_HASHTAG) { await setState2(kv, chatId, null); await adminSay(env, chatId, MENUS.hashtag.text, MENUS.hashtag.rows); return true; }
  if (text === T_CANCEL) { await setState2(kv, chatId, null); await adminSay(env, chatId, "🏠 برگشتیم", MENUS.home.rows); return true; }
  if (text === T_ADD) { await setState2(kv, chatId, { mode: "adding" }); await adminSay(env, chatId, "✏️ هر خط: کلمه #هشتگ1 #هشتگ2\nپایان: «❌ لغو»"); return true; }
  if (text === T_DEL) { await setState2(kv, chatId, { mode: "deleting" }); await adminSay(env, chatId, "🗑️ کلمه‌ها را بفرست"); return true; }
  if (text === T_LIST) {
    const bank = await loadHashtagBank(kv);
    const entries = Object.entries(bank.keywords);
    let cur = "📋 بانک هشتگ (" + entries.length + " کلمه)\n\n";
    const chunks = [];
    for (const entry of entries) {
      const line = "• " + entry[0] + " → " + (Array.isArray(entry[1]) ? entry[1].join(" ") : entry[1]) + "\n";
      if ((cur + line).length > 3500) { chunks.push(cur); cur = ""; }
      cur += line;
    }
    if (cur) chunks.push(cur);
    for (const chunk of chunks) await adminSay(env, chatId, chunk);
    return true;
  }
  if (text === T_TEST) { await setState2(kv, chatId, { mode: "testing" }); await adminSay(env, chatId, "🔍 متنی بفرست"); return true; }
  const state = await getState2(kv, chatId);
  if (!state) return false;
  if (state.mode === "adding") {
    const parsed = parseAddInput(text);
    if (!parsed.length) { await adminSay(env, chatId, "⚠️ قالب: کلمه #هشتگ"); return true; }
    const bank = await loadHashtagBank(kv);
    let nw = 0, uw = 0;
    for (const p of parsed) { if (bank.keywords[p.keyword]) uw++; else nw++; bank.keywords[p.keyword] = p.tags; }
    await saveHashtagBank(kv, bank);
    await setState2(kv, chatId, null);
    await adminSay(env, chatId, "✅ جدید: " + nw + " | 🔄 به‌روز: " + uw, MENUS.hashtag.rows);
    return true;
  }
  if (state.mode === "deleting") {
    const words = text.split(/[\n,،]+/).map(function (s) { return normalizeText(s); }).filter(Boolean);
    const bank = await loadHashtagBank(kv);
    let n = 0;
    for (const w of words) { if (bank.keywords[w]) { delete bank.keywords[w]; n++; } }
    await saveHashtagBank(kv, bank);
    await setState2(kv, chatId, null);
    await adminSay(env, chatId, n ? ("🗑️ " + n + " کلمه حذف شد") : "⚠️ پیدا نشد", MENUS.hashtag.rows);
    return true;
  }
  if (state.mode === "testing") {
    const bank = await loadHashtagBank(kv);
    const normalized = normalizeText(text);
    const selected = new Set(); selected.add(bank.branding);
    const matched = [];
    for (const entry of Object.entries(bank.keywords)) {
      const nk = normalizeText(entry[0]);
      if (nk && normalized.includes(nk)) { matched.push(entry[0]); (Array.isArray(entry[1]) ? entry[1] : [entry[1]]).forEach(function (t) { selected.add(t); }); }
    }
    if (selected.size === 1) selected.add(bank.fallback);
    await adminSay(env, chatId, "🔍 کلمات: " + (matched.length ? matched.join("، ") : "هیچ") + "\nهشتگ‌ها: " + Array.from(selected).slice(0, 3).join(" "));
    return true;
  }
  return false;
}

async function onWebhook(request, env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);
  if (env.BALE_WEBHOOK_SECRET) {
    const received = request.headers.get("X-Bale-Bot-Api-Secret-Token") || request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (received !== env.BALE_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
  }
  let body;
  try { body = await request.json(); }
  catch (e) { return new Response("bad json", { status: 400 }); }
  const msg = body ? (body.channel_post || body.message) : null;
  if (!msg && body && body.edited_channel_post) {
    if (c.acceptEdits) return await processMessage(KV, c, env, body.edited_channel_post, body, true);
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "edited_post" }), { headers: { "Content-Type": "application/json" } });
  }
  if (!msg) return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { "Content-Type": "application/json" } });
  return await processMessage(KV, c, env, msg, body, false);
}

async function processMessage(KV, c, env, msg, body, isEdit) {
  const chatId = String(msg.chat ? msg.chat.id : "");
  const messageId = msg.message_id;
  if (chatId === c.admin) {
    if (!(c.dest && chatId === c.dest)) {
      const handled = await handleTagAdmin(env, KV, c, msg);
      if (handled) return new Response(JSON.stringify({ ok: true, admin: true }), { headers: { "Content-Type": "application/json" } });
    }
  }
  if (c.dest && chatId === c.dest) return new Response(JSON.stringify({ ok: true, ignored: true, reason: "dest_echo" }), { headers: { "Content-Type": "application/json" } });
  if (c.source) {
    const sourceMatches = chatId === c.source || chatId === "-100" + c.source;
    if (!sourceMatches) {
      console.log(JSON.stringify({ event: "SOURCE_REJECTED", chatId: chatId, expected: c.source }));
      return new Response(JSON.stringify({ ok: true, ignored: true, reason: "source_mismatch" }), { headers: { "Content-Type": "application/json" } });
    }
  }
  const item = buildItemFromMessage(msg);
  const result = await withState(KV, function (st) {
    if (item.hash && st.hashes.includes(item.hash)) {
      st.sched.ignored = (st.sched.ignored || 0) + 1; st.sched.lastIgnoreReason = "duplicate_hash";
      return { dup: true, reason: "duplicate_hash" };
    }
    if (st.items.some(function (x) { return x.id === item.id; })) {
      st.sched.ignored = (st.sched.ignored || 0) + 1; st.sched.lastIgnoreReason = "duplicate_id";
      return { dup: true, reason: "duplicate_id" };
    }
    if (msg.media_group_id) {
      const mgid = String(msg.media_group_id);
      const a = st.albums[mgid] || { id: "album-" + chatId + "-" + mgid, type: "album", sourceChatId: chatId, mediaGroupId: mgid, items: [], updatedAt: 0 };
      if (!a.items.some(function (x) { return x.id === item.id; })) a.items.push(item);
      a.updatedAt = Date.now();
      st.albums[mgid] = a;
    } else { st.items.push(item); }
    if (item.hash) { st.hashes.push(item.hash); while (st.hashes.length > c.hashHistory) st.hashes.shift(); }
    st.sched.received = (st.sched.received || 0) + 1;
    return { ok: true, album: !!msg.media_group_id, queueLen: st.items.length };
  });
  if (result.dup) {
    console.log(JSON.stringify({ event: "DUPLICATE", reason: result.reason, id: item.id }));
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "duplicate" }), { headers: { "Content-Type": "application/json" } });
  }
  console.log(JSON.stringify({ event: result.album ? "ALBUM_QUEUED" : "MESSAGE_QUEUED", mid: messageId, type: item.type, queueLen: result.queueLen }));
  return new Response(JSON.stringify({ ok: true, queued: result.album ? "album" : item.type, queueLen: result.queueLen }), { headers: { "Content-Type": "application/json" } });
}

function backoffSeconds(attempt, retryAfter) {
  if (retryAfter > 0) return Math.max(60, retryAfter);
  const delays = [60, 120, 240, 480, 900];
  return delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)];
}

async function onCron(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);
  await migrate(KV);

  const pre = await readState(KV);
  const today = new Date().toISOString().slice(0, 10);
  const stuck = pre.items.some(function (it) { return it.state === "processing" && (Date.now() - (it.processingAt || 0)) > 600000; });
  if (stuck || (pre.usage && pre.usage.day !== today)) {
    await withState(KV, function (s) {
      const now2 = Date.now();
      for (const it of s.items) {
        if (it.state === "processing" && (now2 - (it.processingAt || 0)) > 600000) { it.state = "pending"; it.processingAt = 0; }
      }
      if (s.usage && s.usage.day !== today) s.usage = { day: today, w: 0, r: 0, l: 0 };
      return {};
    });
  }

  const st0 = await readState(KV);
  const now = Date.now();
  const dueAlbums = Object.keys(st0.albums).filter(function (k) { return now - (st0.albums[k].updatedAt || 0) >= c.albumQuiet * 1000; });
  if (dueAlbums.length > 0) {
    await withState(KV, function (s) {
      for (const k of dueAlbums) {
        const a = s.albums[k];
        if (a && a.items && a.items.length) s.items.push({ id: a.id, type: "album", sourceChatId: a.sourceChatId, mediaGroupId: a.mediaGroupId, items: a.items, createdAt: now, attempts: 0, state: "pending", retryAt: 0 });
        delete s.albums[k];
      }
      return {};
    });
  }
  if (!inWindow(c)) {
    const stW = await readState(KV);
    if (stW.sched.nextSendAt) await withState(KV, function (s) { s.sched.nextSendAt = 0; return {}; });
    return;
  }
  const st1 = await readState(KV);
  if (c.admin && now - (st1.sched.lastReportAt || 0) >= c.reportInt * 1000) {
    const bank = await loadHashtagBank(KV);
    const txt = "📊 گزارش mynote_bot (V34)\n\n🕐 " + iso(now) + "\n⏰ بازه: " + String(Math.floor(c.windowStart / 60)).padStart(2, "0") + ":" + String(c.windowStart % 60).padStart(2, "0") + " تا " + String(Math.floor(c.windowEnd / 60)).padStart(2, "0") + ":" + String(c.windowEnd % 60).padStart(2, "0") + "\n\n📥 دریافتی: " + st1.sched.received + "\n📤 ارسال موفق: " + st1.sched.sent + "\n🔁 Retry: " + st1.sched.retries + "\n☠️ DLQ: " + st1.dlq.length + "\n❌ Failed: " + st1.sched.failed + "\n📦 صف: " + st1.items.length + "\n🚫 رد شده: " + (st1.sched.ignored || 0) + "\n🏷️ هشتگ‌ها: " + Object.keys(bank.keywords).length + "\n⏭ ارسال بعدی: " + (st1.sched.nextSendAt ? iso(st1.sched.nextSendAt) : "—") + "\n\n" + quotaText(st1) + "\n\n" + (st1.sched.lastError ? "⚠️ خطا: " + st1.sched.lastError : "✅ بدون خطا") + (st1.sched.lastIgnoreReason ? "\n🔎 آخرین رد: " + st1.sched.lastIgnoreReason : "");
    try { await bale(env, "sendMessage", { chat_id: c.admin, text: txt }); } catch (e) { }
    await withState(KV, function (s) { s.sched.lastReportAt = now; return {}; });
  }
  const st2 = await readState(KV);
  if (st2.items.length === 0) {
    if (st2.sched.nextSendAt) await withState(KV, function (s) { s.sched.nextSendAt = 0; return {}; });
    return;
  }
  if (!st2.sched.nextSendAt || st2.sched.nextSendAt <= 0) {
    const delay = Math.floor(c.minDelay + Math.random() * (c.maxDelay - c.minDelay + 1));
    await withState(KV, function (s) { s.sched.nextSendAt = now + delay * 1000; return {}; });
    return;
  }
  if (now < st2.sched.nextSendAt) return;

  const picked = await withState(KV, function (s) {
    const idx = s.items.findIndex(function (it) {
      return it.state === "pending" || (it.state === "retry" && (it.retryAt || 0) <= now) || (it.state === "processing" && (now - (it.processingAt || 0)) > 600000);
    });
    if (idx === -1) return { item: null };
    const item = s.items[idx];
    item.state = "processing";
    item.processingAt = now;
    item.attempts = (item.attempts || 0) + 1;
    s.items[idx] = item;
    const delay = Math.floor(c.minDelay + Math.random() * (c.maxDelay - c.minDelay + 1));
    s.sched.nextSendAt = now + delay * 1000;
    return { item: item };
  });
  if (!picked.item) return;
  const item = picked.item;
  let ok = false, errMsg = "", retryAfter = 0;
  try {
    if (item.type === "album") { await sendAlbum(env, item); if (c.deleteSource) { for (const sub of item.items) await deleteSourceMessage(env, sub); } }
    else { await sendSingle(env, item); await deleteSourceMessage(env, item); }
    ok = true;
    console.log(JSON.stringify({ event: "SEND_SUCCESS", id: item.id, type: item.type }));
  } catch (e) { errMsg = e.message || String(e); retryAfter = e.retryAfter || 0; }

  await withState(KV, function (s) {
    const idx = s.items.findIndex(function (x) { return x.id === item.id; });
    if (ok) {
      if (idx !== -1) s.items.splice(idx, 1);
      s.sched.sent = (s.sched.sent || 0) + 1; s.sched.lastSendAt = now; s.sched.lastError = null;
    } else if ((item.attempts || 0) >= c.maxRetries) {
      if (idx !== -1) s.items.splice(idx, 1);
      item.failedAt = now; item.lastError = errMsg; s.dlq.push(item);
      s.sched.failed = (s.sched.failed || 0) + 1; s.sched.lastError = errMsg;
    } else {
      if (idx !== -1) {
        const it = s.items[idx];
        it.state = "retry"; it.retryAt = now + backoffSeconds(it.attempts, retryAfter) * 1000; it.lastError = errMsg;
        s.items[idx] = it;
      }
      s.sched.retries = (s.sched.retries || 0) + 1; s.sched.lastError = errMsg;
    }
    return {};
  });
}

/* 🎯 V34: polling دستی برای وقتی که webhook کار نمی‌کند */
async function pollNow(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  if (!token) return { ok: false, error: "no token" };
  
  // خواندن offset از KV
  let offset = 0;
  try {
    count("r"); const saved = await KV.get(POLL_OFFSET_KEY);
    if (saved) offset = parseInt(saved) || 0;
  } catch (e) {}
  
  // گرفتن آپدیت‌ها
  const res = await fetch(BALE_BASE + token + "/getUpdates?offset=" + offset + "&limit=100&timeout=0");
  const data = await res.json().catch(function () { return null; });
  if (!data || !data.ok) return { ok: false, error: "getUpdates failed" };
  
  const updates = data.result || [];
  let processed = 0, queued = 0, newOffset = offset;
  
  for (const u of updates) {
    if (u.update_id >= newOffset) newOffset = u.update_id + 1;
    const msg = u.channel_post;
    if (!msg) continue;
    const chatId = String(msg.chat ? msg.chat.id : "");
    
    // چک source
    if (c.source) {
      const sourceMatches = chatId === c.source || chatId === "-100" + c.source;
      if (!sourceMatches) { processed++; continue; }
    }
    // ignore dest echo
    if (c.dest && chatId === c.dest) { processed++; continue; }
    
    const item = buildItemFromMessage(msg);
    await withState(KV, function (st) {
      if (item.hash && st.hashes.includes(item.hash)) return {};
      if (st.items.some(function (x) { return x.id === item.id; })) return {};
      if (msg.media_group_id) {
        const mgid = String(msg.media_group_id);
        const a = st.albums[mgid] || { id: "album-" + chatId + "-" + mgid, type: "album", sourceChatId: chatId, mediaGroupId: mgid, items: [], updatedAt: 0 };
        if (!a.items.some(function (x) { return x.id === item.id; })) a.items.push(item);
        a.updatedAt = Date.now();
        st.albums[mgid] = a;
      } else {
        st.items.push(item);
      }
      if (item.hash) { st.hashes.push(item.hash); while (st.hashes.length > c.hashHistory) st.hashes.shift(); }
      st.sched.received = (st.sched.received || 0) + 1;
      queued++;
      return {};
    });
    processed++;
  }
  
  // ذخیره offset
  try { count("w"); await KV.put(POLL_OFFSET_KEY, String(newOffset), { expirationTtl: 86400 * 7 }); } catch (e) {}
  
  return { ok: true, processed: processed, queued: queued, newOffset: newOffset, updatesCount: updates.length };
}

function isAdmin(req, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const auth = req.headers.get("Authorization");
  if (auth === "Bearer " + key) return true;
  return new URL(req.url).searchParams.get("key") === key;
}
function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } }); }

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    const KV = env.MYNOTE_KV || env.KV;
    if (p === "/webhook" || p === "/telegram/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      try { return await onWebhook(request, env); }
      catch (e) { console.log(JSON.stringify({ event: "WEBHOOK_ERROR", err: e.message })); return json({ ok: false, error: e.message }, 500); }
    }
    if (p === "/health") return json({ ok: true, version: VERSION });
    if (p === "/admin/status") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const st = await readState(KV);
      const bank = await loadHashtagBank(KV);
      const config = cfg(env);
      return json({ version: VERSION, config: { source: config.source, dest: config.dest, windowOn: config.windowOn, deleteSource: config.deleteSource, acceptEdits: config.acceptEdits }, scheduler: st.sched, queue: st.items.length, dlq: st.dlq.length, albums: Object.keys(st.albums).length, hashtagCount: Object.keys(bank.keywords).length, usage: readUsage(st), kvLimits: KV_LIMITS, time: iso() });
    }
    if (p === "/admin/reset") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      await withState(KV, function (st) { st.sched.nextSendAt = 0; st.sched.lastError = null; return {}; });
      return json({ ok: true });
    }
    if (p === "/admin/requeue-dlq") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const r = await withState(KV, function (st) {
        const n = st.dlq.length;
        for (const it of st.dlq) { it.state = "pending"; it.attempts = 0; it.retryAt = 0; st.items.push(it); }
        st.dlq = [];
        return { n: n };
      });
      return json({ ok: true, requeued: r.n });
    }
    if (p === "/admin/reset-hashes") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      await withState(KV, function (st) { st.hashes = []; return {}; });
      return json({ ok: true, message: "hash memory cleared" });
    }
    if (p === "/admin/clear-queue") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const r = await withState(KV, function (st) { const n = st.items.length; st.items = []; return { n: n }; });
      return json({ ok: true, cleared: r.n });
    }
    if (p === "/admin/cleaning-rules") { if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 }); return json({ ok: true, rules: await loadCleaningRules(KV) }); }
    if (p === "/admin/add-forbidden" || p === "/admin/add-emoji" || p === "/admin/add-line" || p === "/admin/remove-forbidden") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const body = await request.json().catch(function () { return null; });
      const rules = await loadCleaningRules(KV);
      const val = (body && (body.phrase || body.emoji || body.pattern)) || url.searchParams.get("phrase") || url.searchParams.get("emoji") || url.searchParams.get("pattern");
      if (!val) return json({ ok: false, error: "value required" }, 400);
      if (p === "/admin/add-forbidden") { if (!rules.forbidden_phrases.includes(val)) rules.forbidden_phrases.push(val); }
      if (p === "/admin/add-emoji") { if (!rules.remove_emojis.includes(val)) rules.remove_emojis.push(val); }
      if (p === "/admin/add-line") { if (!rules.remove_lines.includes(val)) rules.remove_lines.push(val); }
      if (p === "/admin/remove-forbidden") { rules.forbidden_phrases = (rules.forbidden_phrases || []).filter(function (x) { return x !== val; }); }
      await kvPutJSON(KV, CLEAN_RULES_KEY, rules, 2592000);
      return json({ ok: true, rules: rules });
    }
    if (p === "/admin/reset-cleaning-rules") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      await kvPutJSON(KV, CLEAN_RULES_KEY, { forbidden_phrases: [], forbidden_regex: [], replace_rules: [], remove_emojis: [], remove_lines: [] }, 2592000);
      return json({ ok: true });
    }
    if (p === "/admin/tags") { if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 }); return json({ ok: true, bank: await loadHashtagBank(KV) }); }
    /* 🎯 V34: polling دستی */
    if (p === "/admin/poll-now") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      try {
        const result = await pollNow(env);
        return json(result);
      } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    if (p === "/admin/purge-source") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const c = cfg(env);
      const from = Math.max(1, parseInt(url.searchParams.get("from") || "1", 10));
      const span = Math.min(200, Math.max(1, parseInt(url.searchParams.get("span") || "100", 10)));
      const to = from + span - 1;
      let deleted = 0, failed = 0;
      for (let start = from; start <= to; start += 5) {
        const batch = [];
        for (let mid = start; mid <= Math.min(to, start + 4); mid++) batch.push(mid);
        const results = await Promise.all(batch.map(function (mid) {
          return bale(env, "deleteMessage", { chat_id: c.source, message_id: mid }).then(function () { return 1; }).catch(function () { return 0; });
        }));
        for (const r of results) { if (r === 1) deleted++; else failed++; }
      }
      return json({ ok: true, from: from, to: to, deleted: deleted, failed: failed, next_from: to + 1 });
    }
    if (p === "/admin/set-webhook") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
      const webhookUrl = "https://mynote-worker.metabolicbit.workers.dev/webhook";
      try {
        const payload = { url: webhookUrl, allowed_updates: ["message", "channel_post"], drop_pending_updates: false };
        if (env.BALE_WEBHOOK_SECRET) payload.secret_token = env.BALE_WEBHOOK_SECRET;
        const res = await fetch(BALE_BASE + token + "/setWebhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await res.json();
        return json({ ok: true, webhook: webhookUrl, result: data });
      } catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    if (p === "/admin/webhook-info") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
      try { const res = await fetch(BALE_BASE + token + "/getWebhookInfo"); return json({ ok: true, info: await res.json() }); }
      catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    if (p === "/admin/get-updates") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
      try { const res = await fetch(BALE_BASE + token + "/getUpdates?limit=10&timeout=0"); return json({ ok: true, updates: await res.json() }); }
      catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    if (p === "/") { const st = KV ? await readState(KV) : {}; return json({ ok: true, service: "mynote_bot", version: VERSION, stats: st.sched }); }
    return new Response("Not Found", { status: 404 });
  },
  async scheduled(controller, env) {
    try { await onCron(env); }
    catch (e) { console.log(JSON.stringify({ event: "CRON_FATAL", err: e.message })); }
  }
};