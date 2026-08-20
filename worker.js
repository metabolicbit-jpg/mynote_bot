/* ============================================================
   mynote_bot — V21 DEDUP (ضدتکرار قوی)
   - ۳ لایه ضدتکرار برای جلوگیری کامل از ارسال تکراری
   - لایه ۱: seen_msg (chatId + messageId) - هر پست فقط یک بار
   - لایه ۲: hash (محتوا) - ۲۰۰۰ تای آخر
   - لایه ۳: نادیده گرفتن edited_channel_post
   - پیشوند ثابت KV (mynote:) → حفظ state بین دیپلوی‌ها
   - تمیزکاری امن ایموجی (regex با پرچم u)
   - حذف هوشمند خط‌های تزئینی ایموجی
   - قوانین تمیزکاری سفارشی در KV
   - پشتیبانی از URL parameter برای endpoint های ادمین
   - توکن مخفی وب‌هوک (اختیاری)
   - پنجرهٔ ۸:۳۰–۲۲:۳۰ + فاصلهٔ تصادفی ۳–۱۰ دقیقه
   - آلبوم، Retry+Backoff، DLQ، Lock، گزارش ساعتی
============================================================ */
const VERSION = "V21-DEDUP-2026-08-17";
const BALE_BASE = "https://tapi.bale.ai/bot";

const DEFAULTS = {
  MIN_DELAY_SEC: 180, MAX_DELAY_SEC: 600,
  WINDOW_START_MIN: 510, WINDOW_END_MIN: 1350,
  ALBUM_QUIET_SEC: 20, ALBUM_TTL_SEC: 900,
  REPORT_INTERVAL_SEC: 3600, LOCK_TTL_SEC: 120,
  SEEN_TTL_SEC: 604800, DLQ_TTL_SEC: 2592000,
  MSG_SEEN_TTL_SEC: 2592000, // 30 روز
  MAX_RETRIES: 5, HASH_HISTORY: 2000
};

const HASHTAG_BANK_KEY = "mynote:hashtag_bank";
const TAG_STATE_PREFIX = "mynote:tag_state:";

const DEFAULT_BANK = {
  branding: "#یادبگیریم",
  fallback: "#دانستنی",
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

const T_HASHTAG = "🏷️ هشتگ";
const T_ADD = "➕ افزودن کلمه";
const T_DEL = "🗑️ حذف کلمه";
const T_LIST = "📋 مشاهده لیست";
const T_TEST = "🔍 تست هشتگ";
const T_CANCEL = "❌ لغو";

const MENUS = {
  home: { text: "🛠️ منوی مدیریت mynote_bot\nیکی را انتخاب کن:", rows: [[T_HASHTAG]] },
  hashtag: {
    text: "🏷️ مدیریت هشتگ — یکی را انتخاب کن:",
    rows: [[T_ADD, T_DEL], [T_LIST, T_TEST], [T_CANCEL]]
  }
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
    msgSeenTtl: Math.max(3600, n("MSG_SEEN_TTL_SEC", DEFAULTS.MSG_SEEN_TTL_SEC)),
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
function iso(ms) { return new Date(ms || Date.now()).toISOString(); }

function normalizeText(t) {
  return (t || "")
    .replace(/\u0640+/g, "")
    .replace(/ك/g, "ک")
    .replace(/ي/g, "ی")
    .replace(/\s+/g, " ")
    .trim();
}

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
  const lines = t.split("\n").map(function (line) {
    let l = line;
    l = l.replace(/\u0640+/g, "");
    l = l.replace(/\[[^\]]*\]\([^)]*\)?/g, "");
    l = l.replace(/https?:\/\/[^\s]+/g, "");
    l = l.replace(/ble\.ir\/[^\s]*/g, "");
    l = l.replace(/t\.me\/[^\s]*/g, "");
    l = l.replace(/[Ⓜ🅱🅾]/gu, "");
    l = l.replace(/@[a-zA-Z0-9_]+/g, "");
    l = l.replace(/#[^\s]+/g, "");
    l = l.replace(/[\*]+/g, "");
    l = l.replace(/[➖➕🔸▫️▪️◽◾•●○✓✗]/gu, "");
    l = l.replace(/\uFFFD/g, "");
    l = l.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
    l = l.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
    l = l.replace(/[\u200B\u200D\uFE0F]/g, "");
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
    const bank = await kv.get(HASHTAG_BANK_KEY, "json");
    if (bank && bank.keywords) {
      return {
        branding: bank.branding || DEFAULT_BANK.branding,
        fallback: bank.fallback || DEFAULT_BANK.fallback,
        keywords: bank.keywords
      };
    }
  } catch (e) {
    console.log(JSON.stringify({ event: "BANK_LOAD_ERROR", err: e.message }));
  }
  return { branding: DEFAULT_BANK.branding, fallback: DEFAULT_BANK.fallback, keywords: Object.assign({}, DEFAULT_BANK.keywords) };
}
async function saveHashtagBank(kv, bank) {
  await kvPutJSON(kv, HASHTAG_BANK_KEY, bank, 2592000);
}
async function getSmartTags(kv, text) {
  const bank = await loadHashtagBank(kv);
  const selected = new Set();
  selected.add(bank.branding);
  const normalized = normalizeText(text || "");
  for (const entry of Object.entries(bank.keywords)) {
    const keyword = entry[0];
    const tags = entry[1];
    if (keyword && normalized.includes(normalizeText(keyword))) {
      (Array.isArray(tags) ? tags : [tags]).forEach(function (t) { selected.add(t); });
    }
  }
  if (selected.size === 1) selected.add(bank.fallback);
  return Array.from(selected).slice(0, 3).join(" ");
}
async function buildCaption(kv, rawCaption, entities, destUsername) {
  const clean = cleanText(rawCaption || "", entities);
  if (!clean) return null;
  const tags = await getSmartTags(kv, clean);
  return clean + "\n\n📌 منبع: @" + destUsername + "\n\n" + tags;
}

async function loadCleaningRules(kv) {
  try {
    return (await kv.get("mynote:cleaning_rules", "json")) || { forbidden_phrases: [], forbidden_regex: [], replace_rules: [], remove_emojis: [], remove_lines: [] };
  } catch (e) {
    return { forbidden_phrases: [], forbidden_regex: [], replace_rules: [], remove_emojis: [], remove_lines: [] };
  }
}
async function applyCustomRules(kv, text) {
  if (!text) return text;
  const rules = await loadCleaningRules(kv);
  let lines = text.split("\n");
  for (const phrase of rules.forbidden_phrases || []) {
    if (!phrase) continue;
    lines = lines.map(function (l) { return l.split(phrase).join(""); });
  }
  for (const pattern of rules.remove_lines || []) {
    if (!pattern) continue;
    lines = lines.filter(function (l) { return !l.includes(pattern); });
  }
  for (const rx of rules.forbidden_regex || []) {
    if (!rx) continue;
    try {
      const re = new RegExp(rx, "gi");
      lines = lines.map(function (l) { return l.replace(re, ""); });
    } catch (e) { /* ignore */ }
  }
  for (const rule of rules.replace_rules || []) {
    if (!rule || !rule.from) continue;
    lines = lines.map(function (l) { return l.split(rule.from).join(rule.to || ""); });
  }
  for (const emoji of rules.remove_emojis || []) {
    if (!emoji) continue;
    lines = lines.map(function (l) { return l.split(emoji).join(""); });
  }
  return lines.map(function (l) { return l.trim(); }).filter(function (x) { return x.length > 0; }).join("\n").trim();
}

function contentHash(text, fileId, chatId, messageId) {
  const norm = normalizeText(text || "").slice(0, 200);
  const content = (chatId || "") + "|" + (messageId || "") + "|" + norm + "|" + (fileId || "");
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

async function kvGetJSON(kv, key) {
  try { return await kv.get(key, { type: "json", cacheTtl: 30 }); }
  catch (e) { console.log(JSON.stringify({ event: "KV_GET_ERROR", key: key, err: e.message })); throw e; }
}
async function kvPutJSON(kv, key, value, ttl) {
  try {
    const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : {};
    await kv.put(key, JSON.stringify(value), opts);
  } catch (e) { console.log(JSON.stringify({ event: "KV_PUT_ERROR", key: key, err: e.message })); throw e; }
}
async function kvPutText(kv, key, value, ttl) {
  try {
    const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : {};
    await kv.put(key, String(value), opts);
  } catch (e) { console.log(JSON.stringify({ event: "KV_PUT_TEXT_ERROR", key: key, err: e.message })); throw e; }
}
async function kvDeleteSafe(kv, key) {
  try { await kv.delete(key); } catch (e) { /* ignore */ }
}

async function bale(env, method, payload) {
  const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
  if (!token) throw new Error("BALE_BOT_TOKEN missing");
  const res = await fetch(BALE_BASE + token + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || data.ok !== true) {
    const e = new Error("Bale " + method + ": " + ((data && data.description) || res.status));
    e.status = res.status;
    e.retryAfter = data && data.parameters ? data.parameters.retry_after : null;
    e.retryable = res.status === 429 || res.status >= 500 || !data;
    throw e;
  }
  return data.result;
}

const QP = "mynote:q:";
const AP = "mynote:album:";
const DP = "mynote:dlq:";
const HASH_KEY = "mynote:hashes";
const SCHED_KEY = "mynote:sched";
const LOCK_KEY = "mynote:lock";
const SEEN_PREFIX = "mynote:seen:";
const MSG_SEEN_PREFIX = "mynote:seen_msg:";

async function listPrefix(kv, prefix, limit) {
  const r = await kv.list({ prefix: prefix, limit: limit || 1000 });
  const items = [];
  for (const k of r.keys) {
    const v = await kvGetJSON(kv, k.name);
    if (v) items.push({ key: k.name, item: v });
  }
  return items.sort(function (a, b) { return (a.item.createdAt || 0) - (b.item.createdAt || 0); });
}

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
   🔒 لایه ۱ ضدتکرار: seen_msg
   هر پست (بر اساس chatId + messageId) فقط یک بار وارد صف می‌شود
   با TTL 30 روز
============================================================ */
async function isMessageSeen(kv, chatId, messageId) {
  const key = MSG_SEEN_PREFIX + chatId + ":" + messageId;
  return !!(await kv.get(key));
}
async function markMessageSeen(kv, chatId, messageId, ttl) {
  const key = MSG_SEEN_PREFIX + chatId + ":" + messageId;
  await kvPutText(kv, key, "1", ttl);
}

async function getSched(kv) {
  return (await kvGetJSON(kv, SCHED_KEY)) || { nextSendAt: 0, lastSendAt: 0, lastReportAt: 0, sent: 0, failed: 0, retries: 0, received: 0, deduped: 0, lastError: null };
}
async function saveSched(kv, s) { await kvPutJSON(kv, SCHED_KEY, s, 2592000); }

async function acquireLock(kv, c) {
  const existing = await kv.get(LOCK_KEY);
  if (existing) return null;
  const token = crypto.randomUUID();
  await kv.put(LOCK_KEY, token, { expirationTtl: c.lockTtl });
  return (await kv.get(LOCK_KEY)) === token ? token : null;
}
async function releaseLock(kv, token) {
  if (token && (await kv.get(LOCK_KEY)) === token) await kv.delete(LOCK_KEY);
}

async function isDup(kv, c, updateId) {
  if (updateId == null) return false;
  const key = SEEN_PREFIX + updateId;
  if (await kv.get(key)) return true;
  await kvPutText(kv, key, "1", c.seenTtl);
  return false;
}

async function checkSource(kv, c, chatId) {
  if (c.source) {
    return String(chatId) === c.source || String(chatId) === "-100" + c.source;
  }
  return true;
}

function buildItemFromMessage(msg) {
  const type = detectType(msg);
  const fileId = extractFileId(msg, type);
  const caption = msg.caption || msg.text || "";
  const entities = msg.caption_entities || msg.entities || [];
  return {
    id: "msg-" + msg.chat.id + "-" + msg.message_id,
    type: type,
    sourceChatId: String(msg.chat.id),
    sourceMessageId: Number(msg.message_id),
    fileId: fileId,
    caption: caption,
    entities: entities,
    hash: contentHash(caption, fileId, msg.chat.id, msg.message_id),
    createdAt: Date.now(),
    attempts: 0, state: "pending", retryAt: 0
  };
}

async function enqueueSingle(kv, msg, c) {
  const chatId = String(msg.chat.id);
  const messageId = msg.message_id;

  // 🔒 لایه ۱ ضدتکرار: اگر این پست قبلاً دیده شده، رد کن
  if (await isMessageSeen(kv, chatId, messageId)) {
    console.log(JSON.stringify({ event: "DUPLICATE_MSG_ID", chatId: chatId, mid: messageId }));
    return { duplicated: true, reason: "seen_msg" };
  }

  const item = buildItemFromMessage(msg);

  // 🔒 لایه ۲ ضدتکرار: hash محتوا
  if (await checkAndAddHash(kv, c, item.hash)) {
    console.log(JSON.stringify({ event: "DUPLICATE_CONTENT", hash: item.hash }));
    return { duplicated: true, reason: "hash" };
  }

  // علامت‌گذاری پست به‌عنوان دیده‌شده (۳۰ روز)
  await markMessageSeen(kv, chatId, messageId, c.msgSeenTtl);

  const key = QP + item.createdAt + "-" + crypto.randomUUID().slice(0, 8);
  await kvPutJSON(kv, key, item, c.dlqTtl);
  return { item: item, key: key };
}

async function addToAlbum(kv, msg, c) {
  const chatId = String(msg.chat.id);
  const messageId = msg.message_id;

  // 🔒 لایه ۱: چک کنیم این پیام قبلاً دیده نشده
  if (await isMessageSeen(kv, chatId, messageId)) {
    console.log(JSON.stringify({ event: "ALBUM_DUPLICATE_MSG", mid: messageId }));
    return null;
  }

  const key = AP + chatId + ":" + msg.media_group_id;
  let album = (await kvGetJSON(kv, key)) || {
    id: "album-" + chatId + "-" + msg.media_group_id,
    type: "album",
    sourceChatId: chatId,
    mediaGroupId: String(msg.media_group_id),
    items: [], createdAt: Date.now(), updatedAt: Date.now()
  };
  const item = buildItemFromMessage(msg);
  if (!album.items.find(function (x) { return x.sourceMessageId === item.sourceMessageId; })) album.items.push(item);
  album.updatedAt = Date.now();
  await kvPutJSON(kv, key, album, c.albumTtl);

  // علامت‌گذاری پیام
  await markMessageSeen(kv, chatId, messageId, c.msgSeenTtl);

  return album;
}

async function finalizeAlbums(kv, c) {
  const list = await listPrefix(kv, AP, 1000);
  const now = Date.now();
  let finalized = 0;
  for (const entry of list) {
    const album = entry.item;
    if (now - album.updatedAt < c.albumQuiet * 1000) continue;
    if (!album.items || album.items.length === 0) { await kv.delete(entry.key); continue; }
    const queueItem = {
      id: album.id, type: "album",
      sourceChatId: album.sourceChatId,
      mediaGroupId: album.mediaGroupId,
      items: album.items,
      createdAt: album.createdAt, attempts: 0, state: "pending", retryAt: 0
    };
    await kvPutJSON(kv, QP + album.createdAt + "-" + crypto.randomUUID().slice(0, 8), queueItem, c.dlqTtl);
    await kv.delete(entry.key);
    finalized++;
  }
  return finalized;
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

async function sendSingle(env, item) {
  const c = cfg(env);
  const kv = env.MYNOTE_KV || env.KV;
  const caption = await makeCaption(env, kv, item);
  let method, payload;
  switch (item.type) {
    case "photo": method = "sendPhoto"; payload = { chat_id: c.dest, photo: item.fileId, caption: caption || undefined }; break;
    case "video": method = "sendVideo"; payload = { chat_id: c.dest, video: item.fileId, caption: caption || undefined }; break;
    case "document": method = "sendDocument"; payload = { chat_id: c.dest, document: item.fileId, caption: caption || undefined }; break;
    case "audio": method = "sendAudio"; payload = { chat_id: c.dest, audio: item.fileId, caption: caption || undefined }; break;
    case "voice": method = "sendVoice"; payload = { chat_id: c.dest, voice: item.fileId, caption: caption || undefined }; break;
    case "animation": method = "sendAnimation"; payload = { chat_id: c.dest, animation: item.fileId, caption: caption || undefined }; break;
    case "sticker": method = "sendSticker"; payload = { chat_id: c.dest, sticker: item.fileId }; break;
    default: method = "sendMessage"; payload = { chat_id: c.dest, text: caption || item.caption || "—" };
  }
  return await bale(env, method, payload);
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
  try {
    return await bale(env, "sendMediaGroup", { chat_id: c.dest, media: media });
  } catch (e) {
    console.log(JSON.stringify({ event: "ALBUM_FALLBACK", err: e.message }));
    let sentCount = 0;
    for (const sub of item.items) { await sendSingle(env, sub); sentCount++; }
    if (sentCount === 0) throw e;
    return { partial: true, sentCount: sentCount };
  }
}

async function deleteSourceMessage(env, item) {
  const c = cfg(env);
  if (!c.deleteSource) return;
  try {
    await bale(env, "deleteMessage", { chat_id: item.sourceChatId, message_id: item.sourceMessageId });
  } catch (e) {
    console.log(JSON.stringify({ event: "DELETE_SOURCE_FAIL", err: e.message }));
  }
}

async function getState(kv, chatId) {
  try { return await kv.get(TAG_STATE_PREFIX + chatId, "json"); }
  catch (e) { return null; }
}
async function setState(kv, chatId, state) {
  if (!state) { await kvDeleteSafe(kv, TAG_STATE_PREFIX + chatId); return; }
  await kvPutJSON(kv, TAG_STATE_PREFIX + chatId, state, 3600);
}
function makeKeyboard(rows) { return { keyboard: rows, resize_keyboard: true }; }
async function adminSay(env, chatId, text, rows) {
  const payload = { chat_id: chatId, text: text };
  if (rows) payload.reply_markup = makeKeyboard(rows);
  try { await bale(env, "sendMessage", payload); }
  catch (e) { console.log(JSON.stringify({ event: "ADMIN_SAY_ERROR", err: e.message })); }
}

function parseAddInput(text) {
  const out = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      try {
        const arr = JSON.parse(line);
        for (const obj of arr) {
          if (obj && obj.keyword) {
            const tags = Array.isArray(obj.tags) ? obj.tags : (obj.tag ? [obj.tag] : []);
            if (tags.length) out.push({ keyword: normalizeText(obj.keyword), tags: tags.map(function (t) { return String(t).startsWith("#") ? t : "#" + t; }) });
          }
        }
        continue;
      } catch (e) { /* fallthrough */ }
    }
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.keyword) {
          const tags = Array.isArray(obj.tags) ? obj.tags : (obj.tag ? [obj.tag] : []);
          if (tags.length) out.push({ keyword: normalizeText(obj.keyword), tags: tags.map(function (t) { return String(t).startsWith("#") ? t : "#" + t; }) });
        }
        continue;
      } catch (e) { /* fallthrough */ }
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

  if (text === "/start" || text === "/menu" || text === "/tags") {
    await setState(kv, chatId, null);
    await adminSay(env, chatId, MENUS.home.text, MENUS.home.rows);
    return true;
  }
  if (text === T_HASHTAG) {
    await setState(kv, chatId, null);
    await adminSay(env, chatId, MENUS.hashtag.text, MENUS.hashtag.rows);
    return true;
  }
  if (text === T_CANCEL) {
    await setState(kv, chatId, null);
    await adminSay(env, chatId, "🏠 برگشتیم به منوی اصلی", MENUS.home.rows);
    return true;
  }
  if (text === T_ADD) {
    await setState(kv, chatId, { mode: "adding" });
    await adminSay(env, chatId, "✏️ هر خط را به این شکل بنویس:\nکلمه #هشتگ1 #هشتگ2\n\nمثال:\nاختاپوس #حیات_وحش #جانوران\nپسته #تغذیه\n\nوقتی تمام شد «❌ لغو» را بزن.");
    return true;
  }
  if (text === T_DEL) {
    await setState(kv, chatId, { mode: "deleting" });
    await adminSay(env, chatId, "🗑️ کلمه‌هایی که می‌خواهی حذف شوند را بفرست (هر خط یکی، یا با ویرگول).");
    return true;
  }
  if (text === T_LIST) {
    const bank = await loadHashtagBank(kv);
    const entries = Object.entries(bank.keywords);
    const header = "📋 بانک هشتگ (" + entries.length + " کلمه)\n\n";
    const chunks = [];
    let cur = header;
    for (const entry of entries) {
      const line = "• " + entry[0] + " → " + (Array.isArray(entry[1]) ? entry[1].join(" ") : entry[1]) + "\n";
      if ((cur + line).length > 3500) { chunks.push(cur); cur = ""; }
      cur += line;
    }
    if (cur) chunks.push(cur);
    for (const chunk of chunks) await adminSay(env, chatId, chunk);
    return true;
  }
  if (text === T_TEST) {
    await setState(kv, chatId, { mode: "testing" });
    await adminSay(env, chatId, "🔍 متنی بفرست تا هشتگ‌های تولیدشده برایش را ببینی.");
    return true;
  }

  const state = await getState(kv, chatId);
  if (!state) return false;

  if (state.mode === "adding") {
    const parsed = parseAddInput(text);
    if (!parsed.length) {
      await adminSay(env, chatId, "⚠️ چیزی نفهمیدم! هر خط باید این شکلی باشه:\nکلمه #هشتگ");
      return true;
    }
    const bank = await loadHashtagBank(kv);
    const newWords = [];
    const updatedWords = [];
    for (const p of parsed) {
      if (bank.keywords[p.keyword]) updatedWords.push(p);
      else newWords.push(p);
      bank.keywords[p.keyword] = p.tags;
    }
    await saveHashtagBank(kv, bank);
    await setState(kv, chatId, null);
    let msgText = "";
    if (newWords.length > 0) {
      msgText += "✅ " + newWords.length + " کلمه **جدید** اضافه شد:\n";
      msgText += newWords.slice(0, 3).map(function (p) { return "• " + p.keyword + " → " + p.tags.join(" "); }).join("\n");
      if (newWords.length > 3) msgText += "\n... و " + (newWords.length - 3) + " مورد دیگر";
      msgText += "\n\n";
    }
    if (updatedWords.length > 0) {
      msgText += "🔄 " + updatedWords.length + " کلمه **به‌روزرسانی** شد:\n";
      msgText += updatedWords.slice(0, 3).map(function (p) { return "• " + p.keyword + " → " + p.tags.join(" "); }).join("\n");
      if (updatedWords.length > 3) msgText += "\n... و " + (updatedWords.length - 3) + " مورد دیگر";
      msgText += "\n\n";
    }
    msgText += "از پست بعدی استفاده می‌شه 🎯";
    await adminSay(env, chatId, msgText, MENUS.hashtag.rows);
    return true;
  }

  if (state.mode === "deleting") {
    const words = text.split(/[\n,،]+/).map(function (s) { return normalizeText(s); }).filter(Boolean);
    const bank = await loadHashtagBank(kv);
    let n = 0;
    const found = [];
    for (const w of words) {
      if (bank.keywords[w]) { delete bank.keywords[w]; n++; found.push(w); }
    }
    await saveHashtagBank(kv, bank);
    await setState(kv, chatId, null);
    const msg2 = n ? ("🗑️ " + n + " کلمه حذف شد:\n" + found.join("، ")) : "⚠️ هیچ‌کدام پیدا نشد.";
    await adminSay(env, chatId, msg2, MENUS.hashtag.rows);
    return true;
  }

  if (state.mode === "testing") {
    const bank = await loadHashtagBank(kv);
    const normalized = normalizeText(text);
    const selected = new Set();
    selected.add(bank.branding);
    const matched = [];
    for (const entry of Object.entries(bank.keywords)) {
      const nk = normalizeText(entry[0]);
      if (nk && normalized.includes(nk)) {
        matched.push(entry[0]);
        (Array.isArray(entry[1]) ? entry[1] : [entry[1]]).forEach(function (t) { selected.add(t); });
      }
    }
    if (selected.size === 1) selected.add(bank.fallback);
    const finalTags = Array.from(selected).slice(0, 3);
    await adminSay(env, chatId, "🔍 نتیجه تست:\n\nکلمات مطابقت‌کرده: " + (matched.length ? matched.join("، ") : "هیچ") + "\nهشتگ‌های تولیدی: " + finalTags.join(" "));
    return true;
  }
  return false;
}

async function onWebhook(request, env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);

  const configuredSecret = env.BALE_WEBHOOK_SECRET;
  if (configuredSecret) {
    const received = request.headers.get("X-Bale-Bot-Api-Secret-Token") || request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (received !== configuredSecret) {
      console.log(JSON.stringify({ event: "WEBHOOK_SECRET_REJECTED" }));
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response("bad json", { status: 400 }); }

  if (await isDup(KV, c, body ? body.update_id : null)) {
    return new Response(JSON.stringify({ ok: true, duplicate: true }), { headers: { "Content-Type": "application/json" } });
  }

  // 🚫 نادیده گرفتن کامل edited_channel_post (باعث تکرار می‌شد)
  if (body && body.edited_channel_post) {
    console.log(JSON.stringify({ event: "IGNORED_EDIT", mid: body.edited_channel_post.message_id }));
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "edited_post" }), { headers: { "Content-Type": "application/json" } });
  }

  const msg = body ? (body.channel_post || body.message) : null;
  if (!msg) return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { "Content-Type": "application/json" } });

  const chatId = String(msg.chat ? msg.chat.id : "");
  if (chatId === c.admin) {
    console.log(JSON.stringify({ event: "ADMIN_MESSAGE", chatId: chatId, text: (msg.text || "").substring(0, 50) }));
  }

  if (c.admin && chatId === c.admin) {
    if (!(c.dest && chatId === c.dest)) {
      const handled = await handleTagAdmin(env, KV, c, msg);
      if (handled) {
        return new Response(JSON.stringify({ ok: true, admin: true }), { headers: { "Content-Type": "application/json" } });
      }
    }
  }

  if (c.dest && chatId === c.dest) {
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "dest_echo" }), { headers: { "Content-Type": "application/json" } });
  }

  if (!(await checkSource(KV, c, chatId))) {
    console.log(JSON.stringify({ event: "SOURCE_REJECTED", chatId: chatId }));
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: "source" }), { headers: { "Content-Type": "application/json" } });
  }

  const s = await getSched(KV);
  s.received += 1;
  await saveSched(KV, s);

  let resp;
  if (msg.media_group_id) {
    const album = await addToAlbum(KV, msg, c);
    if (!album) {
      resp = { ok: true, ignored: true, reason: "duplicate_album_msg" };
    } else {
      resp = { ok: true, queued: "album_collecting", items: album.items.length };
      console.log(JSON.stringify({ event: "ALBUM_RECEIVED", mid: msg.message_id }));
    }
  } else {
    const result = await enqueueSingle(KV, msg, c);
    if (result.duplicated) {
      resp = { ok: true, ignored: true, reason: "duplicate", detail: result.reason };
      s.deduped = (s.deduped || 0) + 1;
      await saveSched(KV, s);
    } else {
      resp = { ok: true, queued: result.item.type };
      console.log(JSON.stringify({ event: "MESSAGE_QUEUED", type: result.item.type, mid: msg.message_id }));
    }
  }
  return new Response(JSON.stringify(resp), { headers: { "Content-Type": "application/json" } });
}

function backoffSeconds(attempt, retryAfter) {
  if (retryAfter > 0) return Math.max(60, retryAfter);
  const delays = [60, 120, 240, 480, 900];
  return delays[Math.min(Math.max(0, attempt - 1), delays.length - 1)];
}

async function processOne(env, kv, c) {
  const queue = await listPrefix(kv, QP, 1000);
  if (queue.length === 0) return { status: "empty" };
  const now = Date.now();
  const candidate = queue.find(function (entry) {
    return entry.item.state === "pending" || (entry.item.state === "retry" && (entry.item.retryAt || 0) <= now);
  });
  if (!candidate) return { status: "none_ready" };

  const key = candidate.key;
  const item = candidate.item;
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
      await kvPutJSON(kv, DP + item.id, Object.assign({}, item, { failedAt: now }), c.dlqTtl);
      await kv.delete(key);
      console.log(JSON.stringify({ event: "MOVED_TO_DLQ", id: item.id, err: item.lastError }));
      return { status: "dlq", error: item.lastError };
    }
    item.state = "retry";
    item.retryAt = now + backoffSeconds(item.attempts, e.retryAfter || 0) * 1000;
    await kvPutJSON(kv, key, item, c.dlqTtl);
    console.log(JSON.stringify({ event: "RETRY_SCHEDULED", id: item.id, attempt: item.attempts }));
    return { status: "retry", error: item.lastError };
  }
}

async function onCron(env) {
  const KV = env.MYNOTE_KV || env.KV;
  const c = cfg(env);

  try { await finalizeAlbums(KV, c); } catch (e) { console.log(JSON.stringify({ event: "ALBUM_FINALIZE_ERROR", err: e.message })); }

  const lockToken = await acquireLock(KV, c);
  if (!lockToken) { console.log(JSON.stringify({ event: "CRON_SKIPPED_LOCKED" })); return; }

  try {
    const s = await getSched(KV);
    const now = Date.now();

    if (c.admin && now - (s.lastReportAt || 0) >= c.reportInt * 1000) {
      const q = await listPrefix(KV, QP, 1000);
      const d = await listPrefix(KV, DP, 100);
      const txt = "📊 گزارش mynote_bot (V21)\n\n🕐 " + iso(now) + "\n⏰ بازه: " + String(Math.floor(c.windowStart / 60)).padStart(2, "0") + ":" + String(c.windowStart % 60).padStart(2, "0") + " تا " + String(Math.floor(c.windowEnd / 60)).padStart(2, "0") + ":" + String(c.windowEnd % 60).padStart(2, "0") + "\n🧹 تمیزکاری: " + (c.cleanCaptions ? "روشن" : "خاموش") + "\n\n📥 دریافتی: " + s.received + "\n📤 ارسال موفق: " + s.sent + "\n🚫 رد شده (تکراری): " + (s.deduped || 0) + "\n🔁 Retry: " + s.retries + "\n☠️ DLQ: " + d.length + "\n❌ Failed: " + s.failed + "\n📦 صف: " + q.length + "\n⏭ ارسال بعدی: " + (s.nextSendAt ? iso(s.nextSendAt) : "—") + "\n\n" + (s.lastError ? "⚠️ خطا: " + s.lastError : "✅ بدون خطا");
      try {
        await bale(env, "sendMessage", { chat_id: c.admin, text: txt });
        s.lastReportAt = now;
        await saveSched(KV, s);
      } catch (e) { console.log(JSON.stringify({ event: "REPORT_ERROR", err: e.message })); }
    }

    if (!inWindow(c)) { console.log(JSON.stringify({ event: "OUTSIDE_WINDOW", mins: iranMinutes() })); return; }

    const queue = await listPrefix(KV, QP, 1000);
    if (queue.length === 0) { s.nextSendAt = 0; await saveSched(KV, s); return; }

    if (!s.nextSendAt || s.nextSendAt <= 0) {
      const delay = Math.floor(c.minDelay + Math.random() * (c.maxDelay - c.minDelay + 1));
      s.nextSendAt = now + delay * 1000;
      await saveSched(KV, s);
      console.log(JSON.stringify({ event: "NEXT_SEND_SCHEDULED", delay: delay }));
      return;
    }
    if (now < s.nextSendAt) return;

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

function isAdmin(req, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const auth = req.headers.get("Authorization");
  if (auth === "Bearer " + key) return true;
  return new URL(req.url).searchParams.get("key") === key;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    const KV = env.MYNOTE_KV || env.KV;

    if (p === "/webhook" || p === "/telegram/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      try {
        return await onWebhook(request, env);
      } catch (e) {
        console.log(JSON.stringify({ event: "WEBHOOK_ERROR", err: e.message }));
        return json({ ok: false, error: e.message }, 500);
      }
    }
    if (p === "/health") return json({ ok: true, version: VERSION });

    if (p === "/admin/status") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const c = cfg(env);
      const s = await getSched(KV);
      const q = await listPrefix(KV, QP, 1000);
      const d = await listPrefix(KV, DP, 100);
      const a = await listPrefix(KV, AP, 1000);
      const bank = await loadHashtagBank(KV);
      return json({ version: VERSION, config: { source: c.source, dest: c.dest, windowOn: c.windowOn, cleanCaptions: c.cleanCaptions, deleteSource: c.deleteSource }, scheduler: s, queue: q.length, albums: a.length, dlq: d.length, hashtagCount: Object.keys(bank.keywords).length, time: iso() });
    }
    if (p === "/admin/reset") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const s = await getSched(KV);
      s.nextSendAt = 0;
      s.lastError = null;
      await saveSched(KV, s);
      return json({ ok: true });
    }
    if (p === "/admin/requeue-dlq") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const c = cfg(env);
      const list = await listPrefix(KV, DP, 1000);
      let count = 0;
      for (const entry of list) {
        const item = entry.item;
        item.state = "pending";
        item.attempts = 0;
        item.retryAt = 0;
        await kvPutJSON(KV, QP + item.createdAt + "-" + crypto.randomUUID().slice(0, 8), item, c.dlqTtl);
        await KV.delete(entry.key);
        count++;
      }
      return json({ ok: true, requeued: count });
    }

    if (p === "/admin/cleaning-rules") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      return json({ ok: true, rules: await loadCleaningRules(KV) });
    }
    if (p === "/admin/add-forbidden") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const body = await request.json().catch(function () { return null; });
      const phrase = (body && body.phrase) || url.searchParams.get("phrase");
      if (!phrase) return json({ ok: false, error: "phrase required" }, 400);
      const rules = await loadCleaningRules(KV);
      if (!rules.forbidden_phrases.includes(phrase)) rules.forbidden_phrases.push(phrase);
      await kvPutJSON(KV, "mynote:cleaning_rules", rules, 2592000);
      return json({ ok: true, rules: rules });
    }
    if (p === "/admin/remove-forbidden") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const body = await request.json().catch(function () { return null; });
      const phrase = (body && body.phrase) || url.searchParams.get("phrase");
      const rules = await loadCleaningRules(KV);
      rules.forbidden_phrases = (rules.forbidden_phrases || []).filter(function (x) { return x !== phrase; });
      await kvPutJSON(KV, "mynote:cleaning_rules", rules, 2592000);
      return json({ ok: true, rules: rules });
    }
    if (p === "/admin/add-emoji") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const body = await request.json().catch(function () { return null; });
      const emoji = (body && body.emoji) || url.searchParams.get("emoji");
      if (!emoji) return json({ ok: false, error: "emoji required" }, 400);
      const rules = await loadCleaningRules(KV);
      if (!rules.remove_emojis.includes(emoji)) rules.remove_emojis.push(emoji);
      await kvPutJSON(KV, "mynote:cleaning_rules", rules, 2592000);
      return json({ ok: true, rules: rules });
    }
    if (p === "/admin/add-line") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      const body = await request.json().catch(function () { return null; });
      const pattern = (body && body.pattern) || url.searchParams.get("pattern");
      if (!pattern) return json({ ok: false, error: "pattern required" }, 400);
      const rules = await loadCleaningRules(KV);
      if (!rules.remove_lines.includes(pattern)) rules.remove_lines.push(pattern);
      await kvPutJSON(KV, "mynote:cleaning_rules", rules, 2592000);
      return json({ ok: true, rules: rules });
    }
    if (p === "/admin/reset-cleaning-rules") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      await kvPutJSON(KV, "mynote:cleaning_rules", { forbidden_phrases: [], forbidden_regex: [], replace_rules: [], remove_emojis: [], remove_lines: [] }, 2592000);
      return json({ ok: true, message: "rules reset" });
    }

    if (p === "/admin/tags") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      return json({ ok: true, bank: await loadHashtagBank(KV) });
    }

    if (p === "/admin/set-webhook") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
      const webhookUrl = "https://mynote-worker.metabolicbit.workers.dev/webhook";
      try {
        const payload = {
          url: webhookUrl,
          allowed_updates: ["message", "channel_post"],
          drop_pending_updates: false
        };
        if (env.BALE_WEBHOOK_SECRET) payload.secret_token = env.BALE_WEBHOOK_SECRET;
        const res = await fetch(BALE_BASE + token + "/setWebhook", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
        const data = await res.json();
        return json({ ok: true, webhook: webhookUrl, result: data });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (p === "/admin/webhook-info") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const token = env.BALE_BOT_TOKEN || env.BALE_TOKEN;
      try {
        const res = await fetch(BALE_BASE + token + "/getWebhookInfo");
        const data = await res.json();
        return json({ ok: true, info: data });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ===== پاکسازی seen_msg های قدیمی (اختیاری) =====
    if (p === "/admin/cleanup-seen") {
      if (!isAdmin(request, env)) return new Response("Unauthorized", { status: 401 });
      const list = await KV.list({ prefix: MSG_SEEN_PREFIX, limit: 1000 });
      return json({ ok: true, seen_count: list.keys.length, note: "TTL خودکار 30 روزه فعال است" });
    }

    if (p === "/") {
      const s = KV ? await getSched(KV) : {};
      return json({ ok: true, service: "mynote_bot", version: VERSION, stats: s });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env) {
    try {
      await onCron(env);
    } catch (e) {
      console.log(JSON.stringify({ event: "CRON_FATAL", err: e.message, stack: e.stack }));
    }
  }
};​