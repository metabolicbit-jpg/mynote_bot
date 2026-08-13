/*
===========================================================
 mynote_bot — V14 HYBRI FINAL
===========================================================

Architecture:
- Telegram Webhook ingestion
- Independent KV Queue
- Album aggregation
- Batch-safe ingestion
- Random 3–10 minute sending interval
- Persistent scheduler
- Smart retry + exponential backoff
- Dead Letter Queue
- Lease lock
- Duplicate update protection
- 60-minute Bale reporting
- Health / Status / Admin endpoints
- Strong debug logging
- TTL protection: NEVER < 60 seconds

Version:
V14-HYBRID-FINAL-2026-08-13

IMPORTANT:
Cron should be configured in Cloudflare as:

* * * * *

Cron runs every minute.
Actual post sending is controlled internally by nextSendAt.
===========================================================
*/

const VERSION = "V14-HYBRID-FINAL-2026-08-13";

/* =========================================================
   DEFAULT CONFIGURATION
========================================================= */

const DEFAULTS = {
  MIN_DELAY_SEC: 180,          // 3 minutes
  MAX_DELAY_SEC: 600,          // 10 minutes

  ALBUM_QUIET_SEC: 15,

  REPORT_INTERVAL_SEC: 3600,   // 60 minutes

  LOCK_TTL_SEC: 120,

  PROCESSING_LEASE_SEC: 300,

  SEEN_UPDATE_TTL_SEC: 604800, // 7 days

  ALBUM_TTL_SEC: 900,          // 15 minutes

  DLQ_TTL_SEC: 2592000,        // 30 days

  MAX_RETRIES: 5,

  MAX_QUEUE_SCAN: 1000,

  /*
    Maximum successful sends per Cron execution.

    IMPORTANT:
    Keep this at 1 because the actual interval between
    successful posts is controlled by nextSendAt.
  */
  MAX_SENDS_PER_RUN: 1
};


/* =========================================================
   ENVIRONMENT HELPERS
========================================================= */

function getNumber(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) ? value : fallback;
}


function config(env) {
  return {
    MIN_DELAY_SEC: Math.max(
      180,
      getNumber(env, "MIN_DELAY_SEC", DEFAULTS.MIN_DELAY_SEC)
    ),

    MAX_DELAY_SEC: Math.max(
      180,
      getNumber(env, "MAX_DELAY_SEC", DEFAULTS.MAX_DELAY_SEC)
    ),

    ALBUM_QUIET_SEC: Math.max(
      15,
      getNumber(env, "ALBUM_QUIET_SEC", DEFAULTS.ALBUM_QUIET_SEC)
    ),

    REPORT_INTERVAL_SEC: Math.max(
      3600,
      getNumber(env, "REPORT_INTERVAL_SEC", DEFAULTS.REPORT_INTERVAL_SEC)
    ),

    LOCK_TTL_SEC: Math.max(
      60,
      getNumber(env, "LOCK_TTL_SEC", DEFAULTS.LOCK_TTL_SEC)
    ),

    PROCESSING_LEASE_SEC: Math.max(
      60,
      getNumber(
        env,
        "PROCESSING_LEASE_SEC",
        DEFAULTS.PROCESSING_LEASE_SEC
      )
    ),

    SEEN_UPDATE_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "SEEN_UPDATE_TTL_SEC",
        DEFAULTS.SEEN_UPDATE_TTL_SEC
      )
    ),

    ALBUM_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "ALBUM_TTL_SEC",
        DEFAULTS.ALBUM_TTL_SEC
      )
    ),

    DLQ_TTL_SEC: Math.max(
      60,
      getNumber(
        env,
        "DLQ_TTL_SEC",
        DEFAULTS.DLQ_TTL_SEC
      )
    ),

    MAX_RETRIES: Math.max(
      1,
      getNumber(env, "MAX_RETRIES", DEFAULTS.MAX_RETRIES)
    ),

    MAX_QUEUE_SCAN: Math.max(
      50,
      getNumber(env, "MAX_QUEUE_SCAN", DEFAULTS.MAX_QUEUE_SCAN)
    ),

    MAX_SENDS_PER_RUN:
      DEFAULTS.MAX_SENDS_PER_RUN
  };
}


/* =========================================================
   KV BINDING
========================================================= */

/*
  Preferred binding name:

  KV

  The fallbacks make migration easier if the previous
  version used another binding name.
*/

function getKV(env) {
  return (
    env.KV ||
    env.QUEUE_KV ||
    env.MY_KV ||
    env.MYNOTE_KV ||
    env.MYNOTE_QUEUE
  );
}


function requireKV(env) {
  const kv = getKV(env);

  if (!kv) {
    throw new Error(
      "KV binding not found. Expected KV / QUEUE_KV / MY_KV / MYNOTE_KV / MYNOTE_QUEUE."
    );
  }

  return kv;
}


/* =========================================================
   SAFE KV FUNCTIONS
========================================================= */

async function kvGetJSON(kv, key) {
  try {
    return await kv.get(key, {
      type: "json",
      cacheTtl: 30
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "KV_GET_ERROR",
        key,
        error: error?.message || String(error)
      })
    );

    throw error;
  }
}


/*
  CRITICAL FIX:

  Cloudflare KV expirationTtl MUST be >= 60.

  This helper guarantees that no accidental value such
  as 50 can ever reach KV.
*/

async function kvPutJSON(kv, key, value, ttlSeconds = null) {
  try {
    const options = {};

    if (ttlSeconds !== null) {
      options.expirationTtl = Math.max(
        60,
        Math.floor(ttlSeconds)
      );
    }

    await kv.put(
      key,
      JSON.stringify(value),
      options
    );

  } catch (error) {

    console.error(
      JSON.stringify({
        event: "KV_PUT_ERROR",
        key,
        ttlRequested: ttlSeconds,
        ttlApplied:
          ttlSeconds === null
            ? null
            : Math.max(60, Math.floor(ttlSeconds)),
        error: error?.message || String(error),
        stack: error?.stack || null
      })
    );

    throw error;
  }
}


async function kvPutText(
  kv,
  key,
  value,
  ttlSeconds = null
) {
  const options = {};

  if (ttlSeconds !== null) {
    options.expirationTtl = Math.max(
      60,
      Math.floor(ttlSeconds)
    );
  }

  await kv.put(
    key,
    String(value),
    options
  );
}


async function kvDelete(kv, key) {
  await kv.delete(key);
}


/* =========================================================
   KEY STRUCTURE
========================================================= */

const KEYS = {
  scheduler: "v14:scheduler",

  lock: "v14:lock",

  queuePrefix: "v14:q:",

  dlqPrefix: "v14:dlq:",

  albumPrefix: "v14:album:",

  seenPrefix: "v14:seen:",

  stats: "v14:stats"
};


function queueKey(createdAt) {
  return (
    KEYS.queuePrefix +
    String(createdAt).padStart(13, "0") +
    ":" +
    crypto.randomUUID()
  );
}


function dlqKey() {
  return (
    KEYS.dlqPrefix +
    String(Date.now()).padStart(13, "0") +
    ":" +
    crypto.randomUUID()
  );
}


function albumKey(sourceChatId, mediaGroupId) {
  return (
    KEYS.albumPrefix +
    encodeURIComponent(String(sourceChatId)) +
    ":" +
    encodeURIComponent(String(mediaGroupId))
  );
}


function seenKey(updateId) {
  return KEYS.seenPrefix + String(updateId);
}


/* =========================================================
   RANDOM SEND DELAY
========================================================= */

function randomInteger(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1)
  ) + min;
}


function randomDelaySeconds(env) {
  const cfg = config(env);

  const min = Math.min(
    cfg.MIN_DELAY_SEC,
    cfg.MAX_DELAY_SEC
  );

  const max = Math.max(
    cfg.MIN_DELAY_SEC,
    cfg.MAX_DELAY_SEC
  );

  return randomInteger(min, max);
}


/* =========================================================
   TIME HELPERS
========================================================= */

function nowMs() {
  return Date.now();
}


function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}


function seconds(ms) {
  return Math.floor(ms / 1000);
}


/* =========================================================
   TELEGRAM API
========================================================= */

function telegramToken(env) {
  return (
    env.TELEGRAM_BOT_TOKEN ||
    env.BOT_TOKEN ||
    env.TELEGRAM_TOKEN
  );
}


async function telegramAPI(
  env,
  method,
  payload
) {
  const token = telegramToken(env);

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not configured."
    );
  }

  const url =
    "https://api.telegram.org/bot" +
    token +
    "/" +
    method;

  let response;

  try {

    response = await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify(payload)
      }
    );

  } catch (error) {

    const e = new Error(
      "Telegram network error: " +
      (error?.message || String(error))
    );

    e.retryable = true;

    throw e;
  }


  let data;

  try {
    data = await response.json();
  } catch {
    data = null;
  }


  if (
    !response.ok ||
    !data ||
    data.ok !== true
  ) {

    const description =
      data?.description ||
      `HTTP ${response.status}`;

    const error =
      new Error(
        `Telegram API ${method} failed: ${description}`
      );

    error.status =
      response.status;

    error.retryAfter =
      data?.parameters?.retry_after ||
      null;

    /*
      Telegram 429 is definitely retryable.
    */

    error.retryable =
      response.status === 429 ||
      response.status >= 500 ||
      !data;

    throw error;
  }


  return data.result;
}


/* =========================================================
   TELEGRAM COPY
========================================================= */

/*
  copyMessages is intentionally used instead of copying
  each message individually.

  This allows Telegram to preserve album grouping.
*/

async function copyQueueItem(
  env,
  item
) {

  if (
    !item ||
    !Array.isArray(item.messageIds) ||
    item.messageIds.length === 0
  ) {
    throw new Error(
      "Queue item has no message IDs."
    );
  }

  const sourceChatId =
    item.sourceChatId;

  const targetChatId =
    item.targetChatId ||
    env.TARGET_CHAT_ID;

  if (!sourceChatId) {
    throw new Error(
      "Queue item sourceChatId is missing."
    );
  }

  if (!targetChatId) {
    throw new Error(
      "TARGET_CHAT_ID is not configured."
    );
  }


  const result =
    await telegramAPI(
      env,
      "copyMessages",
      {
        chat_id: targetChatId,

        from_chat_id:
          sourceChatId,

        message_ids:
          item.messageIds,

        disable_notification:
          false,

        protect_content:
          false
      }
    );


  /*
    Telegram may skip messages that cannot be copied.

    We deliberately treat a partial result as failure
    rather than silently losing part of an album.
  */

  if (
    !Array.isArray(result) ||
    result.length !==
      item.messageIds.length
  ) {

    const error =
      new Error(
        `Telegram copied ${result?.length || 0}/${item.messageIds.length} messages.`
      );

    error.retryable = true;

    throw error;
  }


  return result;
}


/* =========================================================
   BALE API
========================================================= */

function baleToken(env) {
  return (
    env.BALE_BOT_TOKEN ||
    env.BALE_TOKEN
  );
}


function baleChatId(env) {
  return (
    env.BALE_REPORT_CHAT_ID ||
    "6130223429"
  );
}


async function baleAPI(
  env,
  method,
  payload
) {

  const token =
    baleToken(env);

  if (!token) {
    throw new Error(
      "BALE_BOT_TOKEN is not configured."
    );
  }

  const base =
    env.BALE_API_BASE ||
    "https://tapi.bale.ai/bot";


  const url =
    base.replace(/\/$/, "") +
    token +
    "/" +
    method;


  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(payload)
      }
    );


  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
  }


  if (
    !response.ok ||
    data?.ok === false
  ) {

    throw new Error(
      `Bale API ${method} failed: HTTP ${response.status} ${text}`
    );
  }


  return data;
}


/* =========================================================
   BALE REPORT
========================================================= */

async function sendBaleReport(
  env,
  text
) {

  const token =
    baleToken(env);

  if (!token) {

    console.warn(
      JSON.stringify({
        event: "BALE_REPORT_SKIPPED",
        reason:
          "BALE_BOT_TOKEN not configured"
      })
    );

    return false;
  }


  await baleAPI(
    env,
    "sendMessage",
    {
      chat_id:
        baleChatId(env),

      text,

      disable_web_page_preview:
        true
    }
  );

  return true;
}


/* =========================================================
   STATS
========================================================= */

async function getStats(kv) {

  const current =
    await kvGetJSON(
      kv,
      KEYS.stats
    );

  if (current) {
    return current;
  }

  return {
    received: 0,
    queued: 0,
    sent: 0,
    retries: 0,
    failed: 0,
    dlq: 0,
    lastError: null,
    lastErrorAt: null,
    lastReceivedAt: null,
    lastSentAt: null
  };
}


async function saveStats(
  kv,
  stats
) {

  await kvPutJSON(
    kv,
    KEYS.stats,
    stats
  );
}


/* =========================================================
   SCHEDULER STATE
========================================================= */

async function getScheduler(kv) {

  const scheduler =
    await kvGetJSON(
      kv,
      KEYS.scheduler
    );

  if (scheduler) {
    return scheduler;
  }

  return {
    version: VERSION,

    nextSendAt: 0,

    lastSendAt: 0,

    lastReportAt: 0,

    lastCronAt: 0,

    lastCron: null,

    createdAt: nowMs()
  };
}


async function saveScheduler(
  kv,
  scheduler
) {

  await kvPutJSON(
    kv,
    KEYS.scheduler,
    scheduler
  );
}


/* =========================================================
   LEASE LOCK
========================================================= */

/*
  This is a lease lock.

  KV is eventually consistent and is NOT an atomic
  compare-and-set database. Therefore this is safer
  than the previous simple lock, but not equivalent
  to a Durable Object mutex.

  The lock TTL is NEVER below 60 seconds.
*/

async function acquireLock(
  kv,
  env
) {

  const cfg = config(env);

  const existing =
    await kvGetJSON(
      kv,
      KEYS.lock
    );


  const now =
    nowMs();


  if (
    existing &&
    existing.expiresAt > now
  ) {

    return null;
  }


  const token =
    crypto.randomUUID();


  const lock = {
    token,

    acquiredAt:
      now,

    expiresAt:
      now +
      cfg.LOCK_TTL_SEC * 1000,

    version:
      VERSION
  };


  await kvPutJSON(
    kv,
    KEYS.lock,
    lock,
    cfg.LOCK_TTL_SEC
  );


  /*
    Verify the write before proceeding.
  */

  const verify =
    await kvGetJSON(
      kv,
      KEYS.lock
    );


  if (
    !verify ||
    verify.token !== token
  ) {

    return null;
  }


  return token;
}


async function releaseLock(
  kv,
  token
) {

  if (!token) {
    return;
  }


  const current =
    await kvGetJSON(
      kv,
      KEYS.lock
    );


  if (
    current &&
    current.token === token
  ) {

    await kvDelete(
      kv,
      KEYS.lock
    );
  }
}


/* =========================================================
   TELEGRAM UPDATE DEDUPLICATION
========================================================= */

async function isDuplicateUpdate(
  kv,
  env,
  updateId
) {

  if (
    updateId === undefined ||
    updateId === null
  ) {
    return false;
  }


  const key =
    seenKey(updateId);


  const exists =
    await kv.get(
      key,
      {
        cacheTtl: 30
      }
    );


  if (exists) {
    return true;
  }


  await kvPutText(
    kv,
    key,
    "1",
    config(env).SEEN_UPDATE_TTL_SEC
  );


  return false;
}


/* =========================================================
   SOURCE / TARGET CONFIG
========================================================= */

function sourceChatId(env) {

  return String(
    env.SOURCE_CHAT_ID ||
    env.SOURCE_CHANNEL_ID ||
    ""
  );
}


function targetChatId(env) {

  return String(
    env.TARGET_CHAT_ID ||
    env.DESTINATION_CHAT_ID ||
    ""
  );
}


/* =========================================================
   ENQUEUE SINGLE MESSAGE
========================================================= */

async function enqueueMessage(
  env,
  kv,
  message
) {

  const createdAt =
    Number(message.date)
      ? Number(message.date) * 1000
      : nowMs();


  const item = {

    id:
      crypto.randomUUID(),

    version:
      VERSION,

    type:
      "single",

    sourceChatId:
      String(message.chat.id),

    targetChatId:
      targetChatId(env),

    messageIds:
      [Number(message.message_id)],

    mediaGroupId:
      null,

    createdAt,

    queuedAt:
      nowMs(),

    attempts:
      0,

    retryAt:
      0,

    state:
      "pending"
  };


  const key =
    queueKey(createdAt);


  await kvPutJSON(
    kv,
    key,
    item
  );


  return {
    key,
    item
  };
}


/* =========================================================
   ENQUEUE ALBUM
========================================================= */

async function addAlbumMessage(
  env,
  kv,
  message
) {

  const mediaGroupId =
    String(
      message.media_group_id
    );


  const key =
    albumKey(
      message.chat.id,
      mediaGroupId
    );


  let album =
    await kvGetJSON(
      kv,
      key
    );


  if (!album) {

    album = {

      version:
        VERSION,

      type:
        "album",

      sourceChatId:
        String(message.chat.id),

      targetChatId:
        targetChatId(env),

      mediaGroupId,

      messageIds: [],

      messages: [],

      createdAt:
        nowMs(),

      updatedAt:
        nowMs()
    };
  }


  const messageId =
    Number(message.message_id);


  /*
    Deduplicate individual album messages.
  */

  if (
    !album.messageIds.includes(
      messageId
    )
  ) {

    album.messageIds.push(
      messageId
    );

    album.messages.push({

      messageId,

      date:
        Number(message.date) || 0
    });
  }


  album.messageIds =
    [...new Set(
      album.messageIds
    )]
    .sort(
      (a, b) => a - b
    );


  album.messages =
    album.messages
      .sort(
        (a, b) =>
          a.messageId -
          b.messageId
      );


  album.updatedAt =
    nowMs();


  await kvPutJSON(
    kv,
    key,
    album,
    config(env).ALBUM_TTL_SEC
  );


  return album;
}


/* =========================================================
   TELEGRAM WEBHOOK HANDLER
========================================================= */

async function handleTelegramUpdate(
  request,
  env
) {

  const kv =
    requireKV(env);


  const body =
    await request.json();


  /*
    Telegram webhook secret.
  */

  const configuredSecret =
    env.TELEGRAM_WEBHOOK_SECRET;


  if (configuredSecret) {

    const receivedSecret =
      request.headers.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );


    if (
      receivedSecret !==
      configuredSecret
    ) {

      console.warn(
        JSON.stringify({
          event:
            "WEBHOOK_SECRET_REJECTED"
        })
      );

      return new Response(
        "Unauthorized",
        {
          status: 401
        }
      );
    }
  }


  const updateId =
    body?.update_id;


  if (
    await isDuplicateUpdate(
      kv,
      env,
      updateId
    )
  ) {

    return Response.json({
      ok: true,
      duplicate: true
    });
  }


  /*
    We only process channel_post.

    edited_channel_post is intentionally ignored
    because V14 is a publishing queue, not an editor.
  */

  const message =
    body?.channel_post;


  if (!message) {

    return Response.json({
      ok: true,
      ignored: true
    });
  }


  const expectedSource =
    sourceChatId(env);


  if (
    expectedSource &&
    String(message.chat.id) !==
      expectedSource
  ) {

    console.warn(
      JSON.stringify({
        event:
          "SOURCE_CHAT_MISMATCH",

        expected:
          expectedSource,

        received:
          String(message.chat.id)
      })
    );


    return Response.json({
      ok: true,
      ignored: true,
      reason:
        "source_chat_mismatch"
    });
  }


  const stats =
    await getStats(kv);


  stats.received += 1;

  stats.lastReceivedAt =
    nowMs();


  /*
    ALBUM
  */

  if (
    message.media_group_id
  ) {

    const album =
      await addAlbumMessage(
        env,
        kv,
        message
      );


    stats.queued += 1;


    await saveStats(
      kv,
      stats
    );


    console.log(
      JSON.stringify({
        event:
          "ALBUM_RECEIVED",

        mediaGroupId:
          message.media_group_id,

        messages:
          album.messageIds,

        updateId
      })
    );


    return Response.json({
      ok: true,

      queued:
        "album_pending",

      media_group_id:
        message.media_group_id,

      messages:
        album.messageIds.length
    });
  }


  /*
    SINGLE MESSAGE
  */

  const result =
    await enqueueMessage(
      env,
      kv,
      message
    );


  stats.queued += 1;


  await saveStats(
    kv,
    stats
  );


  console.log(
    JSON.stringify({
      event:
        "MESSAGE_QUEUED",

      queueKey:
        result.key,

      messageId:
        message.message_id,

      updateId
    })
  );


  return Response.json({
    ok: true,
    queued: true,
    queueKey:
      result.key
  });
}


/* =========================================================
   FINALIZE QUIET ALBUMS
========================================================= */

async function finalizeAlbums(
  env,
  kv
) {

  const cfg =
    config(env);


  const listed =
    await kv.list({
      prefix:
        KEYS.albumPrefix,

      limit:
        cfg.MAX_QUEUE_SCAN
    });


  let finalized =
    0;


  for (
    const keyInfo of listed.keys
  ) {

    const key =
      keyInfo.name;


    const album =
      await kvGetJSON(
        kv,
        key
      );


    if (!album) {
      continue;
    }


    const age =
      nowMs() -
      Number(album.updatedAt || 0);


    if (
      age <
      cfg.ALBUM_QUIET_SEC * 1000
    ) {

      continue;
    }


    if (
      !Array.isArray(
        album.messageIds
      ) ||
      album.messageIds.length === 0
    ) {

      await kvDelete(
        kv,
        key
      );

      continue;
    }


    /*
      Re-read before promotion.

      This prevents deleting an album that received
      another webhook between the initial read and now.
    */

    const verify =
      await kvGetJSON(
        kv,
        key
      );


    if (
      !verify ||
      verify.updatedAt !==
        album.updatedAt
    ) {

      continue;
    }


    const createdAt =
      Number(
        album.messages?.[0]?.date
      )
        ? Number(
            album.messages[0].date
          ) * 1000
        : Number(
            album.createdAt
          ) || nowMs();


    const item = {

      id:
        crypto.randomUUID(),

      version:
        VERSION,

      type:
        "album",

      sourceChatId:
        album.sourceChatId,

      targetChatId:
        album.targetChatId,

      messageIds:
        album.messageIds,

      mediaGroupId:
        album.mediaGroupId,

      createdAt,

      queuedAt:
        nowMs(),

      attempts:
        0,

      retryAt:
        0,

      state:
        "pending"
    };


    const queueKeyName =
      queueKey(createdAt);


    await kvPutJSON(
      kv,
      queueKeyName,
      item
    );


    await kvDelete(
      kv,
      key
    );


    finalized += 1;


    console.log(
      JSON.stringify({
        event:
          "ALBUM_FINALIZED",

        queueKey:
          queueKeyName,

        mediaGroupId:
          album.mediaGroupId,

        messages:
          album.messageIds
      })
    );
  }


  return finalized;
}


/* =========================================================
   QUEUE LIST
========================================================= */

async function listQueue(
  env,
  kv
) {

  const cfg =
    config(env);


  const listed =
    await kv.list({
      prefix:
        KEYS.queuePrefix,

      limit:
        cfg.MAX_QUEUE_SCAN
    });


  const items = [];


  for (
    const keyInfo of listed.keys
  ) {

    const key =
      keyInfo.name;


    const item =
      await kvGetJSON(
        kv,
        key
      );


    if (!item) {
      continue;
    }


    items.push({
      key,
      item
    });
  }


  items.sort(
    (a, b) =>
      Number(
        a.item.createdAt || 0
      ) -
      Number(
        b.item.createdAt || 0
      )
  );


  return items;
}


/* =========================================================
   DLQ LIST
========================================================= */

async function listDLQ(
  env,
  kv
) {

  const cfg =
    config(env);


  const listed =
    await kv.list({
      prefix:
        KEYS.dlqPrefix,

      limit:
        cfg.MAX_QUEUE_SCAN
    });


  return listed.keys;
}


/* =========================================================
   RETRY BACKOFF
========================================================= */

function retryDelaySeconds(
  attempt,
  retryAfter
) {

  /*
    Telegram's retry_after has priority.
  */

  if (
    Number.isFinite(
      Number(retryAfter)
    ) &&
    Number(retryAfter) > 0
  ) {

    return Math.max(
      60,
      Number(retryAfter)
    );
  }


  /*
    60
    120
    240
    480
    900
  */

  const delays = [
    60,
    120,
    240,
    480,
    900
  ];


  const index =
    Math.min(
      Math.max(
        0,
        Number(attempt) - 1
      ),
      delays.length - 1
    );


  return delays[index];
}


/* =========================================================
   DEAD LETTER QUEUE
========================================================= */

async function moveToDLQ(
  env,
  kv,
  queueKeyName,
  item,
  error
) {

  const cfg =
    config(env);


  const dlqItem = {

    version:
      VERSION,

    originalQueueKey:
      queueKeyName,

    original:
      item,

    movedAt:
      nowMs(),

    attempts:
      item.attempts,

    error:
      error?.message ||
      String(error),

    retryAfter:
      error?.retryAfter ||
      null
  };


  await kvPutJSON(
    kv,
    dlqKey(),
    dlqItem,
    cfg.DLQ_TTL_SEC
  );


  await kvDelete(
    kv,
    queueKeyName
  );


  const stats =
    await getStats(kv);


  stats.failed += 1;

  stats.dlq += 1;

  stats.lastError =
    dlqItem.error;

  stats.lastErrorAt =
    nowMs();


  await saveStats(
    kv,
    stats
  );


  console.error(
    JSON.stringify({
      event:
        "MOVED_TO_DLQ",

      queueKey:
        queueKeyName,

      attempts:
        item.attempts,

      error:
        dlqItem.error
    })
  );
}


/* =========================================================
   RECOVER STALE PROCESSING ITEM
========================================================= */

async function normalizeItem(
  env,
  kv,
  queueKeyName,
  item
) {

  if (
    item.state !==
    "processing"
  ) {

    return item;
  }


  const leaseUntil =
    Number(
      item.processingUntil || 0
    );


  if (
    leaseUntil >
    nowMs()
  ) {

    return item;
  }


  /*
    Worker may have died during send.

    We return it to pending rather than losing it.
  */

  item.state =
    "pending";

  item.processingUntil =
    0;

  item.recoveredAt =
    nowMs();


  await kvPutJSON(
    kv,
    queueKeyName,
    item
  );


  console.warn(
    JSON.stringify({
      event:
        "STALE_ITEM_RECOVERED",

      queueKey:
        queueKeyName,

      attempts:
        item.attempts
    })
  );


  return item;
}


/* =========================================================
   PROCESS ONE QUEUE ITEM
========================================================= */

async function processOneQueueItem(
  env,
  kv,
  scheduler
) {

  const queue =
    await listQueue(
      env,
      kv
    );


  if (
    queue.length === 0
  ) {

    scheduler.nextSendAt =
      0;

    return {
      status:
        "empty",

      scheduler
    };
  }


  /*
    First queue item = strict FIFO.

    We do NOT skip it for a later post.
  */

  const selected =
    queue[0];


  const key =
    selected.key;


  let item =
    selected.item;


  item =
    await normalizeItem(
      env,
      kv,
      key,
      item
    );


  const now =
    nowMs();


  /*
    If the first item is waiting for retry,
    don't bypass it.
  */

  if (
    Number(item.retryAt || 0) >
    now
  ) {

    scheduler.nextSendAt =
      Number(item.retryAt);

    return {
      status:
        "waiting_retry",

      retryAt:
        Number(item.retryAt),

      scheduler
    };
  }


  /*
    Claim item.
  */

  item.state =
    "processing";

  item.processingAt =
    now;

  item.processingUntil =
    now +
    config(env).PROCESSING_LEASE_SEC *
      1000;


  item.attempts =
    Number(item.attempts || 0) +
    1;


  await kvPutJSON(
    kv,
    key,
    item
  );


  console.log(
    JSON.stringify({
      event:
        "SEND_ATTEMPT",

      queueKey:
        key,

      type:
        item.type,

      messageIds:
        item.messageIds,

      attempt:
        item.attempts
    })
  );


  try {

    const result =
      await copyQueueItem(
        env,
        item
      );


    /*
      SUCCESS
    */

    await kvDelete(
      kv,
      key
    );


    const stats =
      await getStats(kv);


    stats.sent += 1;

    stats.lastSentAt =
      nowMs();

    stats.lastError =
      null;

    stats.lastErrorAt =
      null;


    await saveStats(
      kv,
      stats
    );


    scheduler.lastSendAt =
      nowMs();


    /*
      Check if more posts remain.
    */

    const remaining =
      await listQueue(
        env,
        kv
      );


    if (
      remaining.length > 0
    ) {

      const delay =
        randomDelaySeconds(
          env
        );


      scheduler.nextSendAt =
        nowMs() +
        delay * 1000;


      console.log(
        JSON.stringify({
          event:
            "SEND_SUCCESS",

          queueKey:
            key,

          sentMessages:
            result.length,

          nextDelaySeconds:
            delay,

          nextSendAt:
            iso(
              scheduler.nextSendAt
            )
        })
      );

    } else {

      /*
        Queue is empty.

        nextSendAt = 0 means that when a new
        post arrives, the next Cron will start
        a new random 3–10 minute cycle.
      */

      scheduler.nextSendAt =
        0;


      console.log(
        JSON.stringify({
          event:
            "QUEUE_EMPTY_AFTER_SEND",

          queueKey:
            key
        })
      );
    }


    return {
      status:
        "sent",

      scheduler,

      result
    };

  } catch (error) {

    console.error(
      JSON.stringify({
        event:
          "SEND_ERROR",

        queueKey:
          key,

        attempt:
          item.attempts,

        error:
          error?.message ||
          String(error),

        retryAfter:
          error?.retryAfter ||
          null,

        stack:
          error?.stack ||
          null
      })
    );


    const stats =
      await getStats(kv);


    stats.retries += 1;

    stats.lastError =
      error?.message ||
      String(error);

    stats.lastErrorAt =
      nowMs();


    await saveStats(
      kv,
      stats
    );


    /*
      Retry limit reached.
    */

    if (
      item.attempts >=
      config(env).MAX_RETRIES
    ) {

      await moveToDLQ(
        env,
        kv,
        key,
        item,
        error
      );


      scheduler.nextSendAt =
        nowMs() +
        60 * 1000;


      return {
        status:
          "dlq",

        scheduler
      };
    }


    /*
      Smart retry.
    */

    const delay =
      retryDelaySeconds(
        item.attempts,
        error?.retryAfter
      );


    item.state =
      "pending";

    item.retryAt =
      nowMs() +
      delay * 1000;

    item.processingUntil =
      0;

    item.lastError =
      error?.message ||
      String(error);


    await kvPutJSON(
      kv,
      key,
      item
    );


    scheduler.nextSendAt =
      item.retryAt;


    console.warn(
      JSON.stringify({
        event:
          "RETRY_SCHEDULED",

        queueKey:
          key,

        attempt:
          item.attempts,

        retryDelaySeconds:
          delay,

        retryAt:
          iso(item.retryAt)
      })
    );


    return {
      status:
        "retry",

      scheduler
    };
  }
}


/* =========================================================
   STATUS SNAPSHOT
========================================================= */

async function buildStatus(
  env,
  kv
) {

  const scheduler =
    await getScheduler(kv);


  const stats =
    await getStats(kv);


  const queue =
    await listQueue(
      env,
      kv
    );


  const dlq =
    await listDLQ(
      env,
      kv
    );


  return {

    version:
      VERSION,

    now:
      iso(),

    scheduler: {

      nextSendAt:
        scheduler.nextSendAt
          ? iso(
              scheduler.nextSendAt
            )
          : null,

      lastSendAt:
        scheduler.lastSendAt
          ? iso(
              scheduler.lastSendAt
            )
          : null,

      lastReportAt:
        scheduler.lastReportAt
          ? iso(
              scheduler.lastReportAt
            )
          : null,

      lastCronAt:
        scheduler.lastCronAt
          ? iso(
              scheduler.lastCronAt
            )
          : null,

      lastCron:
        scheduler.lastCron
    },

    queue: {

      count:
        queue.length,

      items:
        queue
          .slice(0, 50)
          .map(
            x => ({
              key:
                x.key,

              type:
                x.item.type,

              messageIds:
                x.item.messageIds,

              attempts:
                x.item.attempts,

              retryAt:
                x.item.retryAt
                  ? iso(
                      x.item.retryAt
                    )
                  : null,

              state:
                x.item.state,

              createdAt:
                iso(
                  x.item.createdAt
                )
            })
          )
    },

    dlq: {

      count:
        dlq.length
    },

    stats
  };
}


/* =========================================================
   60-MINUTE BALE REPORT
========================================================= */

function formatDate(ms) {

  if (!ms) {
    return "—";
  }

  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}


async function maybeSendHourlyReport(
  env,
  kv,
  scheduler
) {

  const cfg =
    config(env);


  const now =
    nowMs();


  const shouldReport =
    !scheduler.lastReportAt ||
    now -
      Number(
        scheduler.lastReportAt
      ) >=
      cfg.REPORT_INTERVAL_SEC *
        1000;


  if (!shouldReport) {

    return false;
  }


  const status =
    await buildStatus(
      env,
      kv
    );


  const text = [

    `🤖 mynote_bot`,

    `V14 HYBRID`,

    ``,

    `📅 گزارش دوره‌ای`,

    `⏱ ${formatDate(now)}`,

    ``,

    `📥 دریافت‌شده: ${status.stats.received}`,

    `📦 Queue: ${status.queue.count}`,

    `📤 ارسال موفق: ${status.stats.sent}`,

    `🔁 Retry: ${status.stats.retries}`,

    `☠️ DLQ: ${status.dlq.count}`,

    `❌ Failed: ${status.stats.failed}`,

    ``,

    `🕐 آخرین ارسال: ${formatDate(status.stats.lastSentAt)}`,

    `📥 آخرین دریافت: ${formatDate(status.stats.lastReceivedAt)}`,

    `⏭ ارسال بعدی: ${
      status.scheduler.nextSendAt || "—"
    }`,

    ``,

    `🔧 Cron: ${scheduler.lastCron || "—"}`,

    `🟢 Version: ${VERSION}`,

    ``,

    status.stats.lastError
      ? `⚠️ آخرین خطا:\n${status.stats.lastError}`
      : `✅ آخرین وضعیت خطا: ندارد`
  ].join("\n");


  try {

    await sendBaleReport(
      env,
      text
    );


    scheduler.lastReportAt =
      now;


    await saveScheduler(
      kv,
      scheduler
    );


    console.log(
      JSON.stringify({
        event:
          "HOURLY_REPORT_SENT"
      })
    );


    return true;

  } catch (error) {

    /*
      VERY IMPORTANT:

      If Bale is temporarily unavailable,
      we DO NOT break the Cron execution.
    */

    console.error(
      JSON.stringify({
        event:
          "BALE_REPORT_ERROR",

        error:
          error?.message ||
          String(error)
      })
    );


    return false;
  }
}


/* =========================================================
   CRON PROCESSOR
========================================================= */

async function processCron(
  controller,
  env
) {

  const kv =
    requireKV(env);


  const cfg =
    config(env);


  /*
    1. Finalize albums first.
  */

  let finalizedAlbums = 0;


  try {

    finalizedAlbums =
      await finalizeAlbums(
        env,
        kv
      );

  } catch (error) {

    console.error(
      JSON.stringify({
        event:
          "ALBUM_FINALIZE_ERROR",

        error:
          error?.message ||
          String(error)
      })
    );
  }


  /*
    2. Acquire lease lock.
  */

  const lockToken =
    await acquireLock(
      kv,
      env
    );


  if (!lockToken) {

    console.log(
      JSON.stringify({
        event:
          "CRON_SKIPPED_LOCKED"
      })
    );

    return;
  }


  try {

    let scheduler =
      await getScheduler(
        kv
      );


    scheduler.lastCronAt =
      nowMs();

    scheduler.lastCron =
      controller?.cron ||
      "* * * * *";


    await saveScheduler(
      kv,
      scheduler
    );


    /*
      3. Hourly report.

      It is inside the lock so two Cron invocations
      cannot normally send duplicate reports.
    */

    await maybeSendHourlyReport(
      env,
      kv,
      scheduler
    );


    /*
      Reload scheduler because the report function
      may have updated lastReportAt.
    */

    scheduler =
      await getScheduler(
        kv
      );


    /*
      4. If queue is empty, do nothing.
    */

    const queue =
      await listQueue(
        env,
        kv
      );


    if (
      queue.length === 0
    ) {

      scheduler.nextSendAt =
        0;


      await saveScheduler(
        kv,
        scheduler
      );


      console.log(
        JSON.stringify({
          event:
            "CRON_IDLE",

          finalizedAlbums
        })
      );


      return;
    }


    /*
      5. If no nextSendAt exists,
         start the first random interval.
    */

    if (
      !scheduler.nextSendAt ||
      scheduler.nextSendAt <= 0
    ) {

      const delay =
        randomDelaySeconds(
          env
        );


      scheduler.nextSendAt =
        nowMs() +
        delay * 1000;


      await saveScheduler(
        kv,
        scheduler
      );


      console.log(
        JSON.stringify({
          event:
            "SCHEDULE_CREATED",

          delaySeconds:
            delay,

          nextSendAt:
            iso(
              scheduler.nextSendAt
            ),

          queue:
            queue.length
        })
      );


      return;
    }


    /*
      6. Not time yet.
    */

    if (
      nowMs() <
      scheduler.nextSendAt
    ) {

      console.log(
        JSON.stringify({
          event:
            "WAITING_FOR_NEXT_SEND",

          queue:
            queue.length,

          nextSendAt:
            iso(
              scheduler.nextSendAt
            ),

          remainingSeconds:
            Math.ceil(
              (
                scheduler.nextSendAt -
                nowMs()
              ) / 1000
            )
        })
      );


      return;
    }


    /*
      7. Send exactly one queue item.
    */

    const result =
      await processOneQueueItem(
        env,
        kv,
        scheduler
      );


    scheduler =
      result.scheduler ||
      scheduler;


    scheduler.lastCronAt =
      nowMs();

    scheduler.lastCron =
      controller?.cron ||
      "* * * * *";


    await saveScheduler(
      kv,
      scheduler
    );


    console.log(
      JSON.stringify({
        event:
          "CRON_COMPLETE",

        status:
          result.status,

        finalizedAlbums,

        nextSendAt:
          scheduler.nextSendAt
            ? iso(
                scheduler.nextSendAt
              )
            : null
      })
    );

  } finally {

    await releaseLock(
      kv,
      lockToken
    );
  }
}


/* =========================================================
   AUTHENTICATION FOR ADMIN ROUTES
========================================================= */

function isAdmin(
  request,
  env
) {

  const configured =
    env.ADMIN_KEY;


  if (!configured) {

    return false;
  }


  const auth =
    request.headers.get(
      "Authorization"
    );


  if (
    auth ===
    `Bearer ${configured}`
  ) {

    return true;
  }


  const url =
    new URL(request.url);


  const key =
    url.searchParams.get(
      "key"
    );


  return key === configured;
}


/* =========================================================
   ADMIN: RESET SCHEDULER
========================================================= */

async function adminResetScheduler(
  env,
  kv
) {

  const scheduler =
    await getScheduler(
      kv
    );


  scheduler.nextSendAt =
    0;


  scheduler.lastError =
    null;


  await saveScheduler(
    kv,
    scheduler
  );


  return {
    ok: true,

    message:
      "Scheduler reset. Next Cron will create a new random 3–10 minute delay."
  };
}


/* =========================================================
   ADMIN: REQUEUE DLQ
========================================================= */

async function adminRequeueDLQ(
  env,
  kv
) {

  const cfg =
    config(env);


  const listed =
    await kv.list({
      prefix:
        KEYS.dlqPrefix,

      limit:
        cfg.MAX_QUEUE_SCAN
    });


  let restored =
    0;


  for (
    const keyInfo of listed.keys
  ) {

    const dlq =
      await kvGetJSON(
        kv,
        keyInfo.name
      );


    if (!dlq?.original) {
      continue;
    }


    const original =
      dlq.original;


    original.state =
      "pending";

    original.retryAt =
      0;

    original.attempts =
      0;

    original.requeuedAt =
      nowMs();


    await kvPutJSON(
      kv,
      queueKey(
        Number(
          original.createdAt
        ) || nowMs()
      ),
      original
    );


    await kvDelete(
      kv,
      keyInfo.name
    );


    restored += 1;
  }


  return {
    ok: true,

    restored
  };
}


/* =========================================================
   ADMIN: SET TELEGRAM WEBHOOK
========================================================= */

async function adminSetWebhook(
  request,
  env
) {

  const publicUrl =
    env.PUBLIC_WORKER_URL;


  if (!publicUrl) {

    throw new Error(
      "PUBLIC_WORKER_URL is not configured."
    );
  }


  const secret =
    env.TELEGRAM_WEBHOOK_SECRET;


  const webhookUrl =
    publicUrl.replace(
      /\/$/,
      ""
    ) +
    "/telegram/webhook";


  const payload = {

    url:
      webhookUrl,

    allowed_updates:
      ["channel_post"],

    drop_pending_updates:
      false
  };


  if (secret) {

    payload.secret_token =
      secret;
  }


  const result =
    await telegramAPI(
      env,
      "setWebhook",
      payload
    );


  return {

    ok: true,

    webhookUrl,

    telegram:
      result
  };
}


/* =========================================================
   FETCH HANDLER
========================================================= */

export default {

  async fetch(
    request,
    env,
    ctx
  ) {

    const url =
      new URL(request.url);


    const path =
      url.pathname;


    /*
      HEALTH
    */

    if (
      path ===
      "/health"
    ) {

      return Response.json({
        ok: true,

        version:
          VERSION,

        time:
          iso()
      });
    }


    /*
      TELEGRAM WEBHOOK
    */

    if (
      path ===
      "/telegram/webhook"
    ) {

      if (
        request.method !==
        "POST"
      ) {

        return new Response(
          "Method Not Allowed",
          {
            status: 405
          }
        );
      }


      try {

        /*
          We deliberately await this.

          If KV fails, returning 500 allows Telegram
          to retry the webhook instead of silently
          losing the post.
        */

        return await handleTelegramUpdate(
          request,
          env
        );

      } catch (error) {

        console.error(
          JSON.stringify({
            event:
              "WEBHOOK_PROCESSING_ERROR",

            error:
              error?.message ||
              String(error),

            stack:
              error?.stack ||
              null
          })
        );


        return Response.json(
          {
            ok: false,

            error:
              "Webhook processing failed."
          },
          {
            status: 500
          }
        );
      }
    }


    /*
      ADMIN STATUS
    */

    if (
      path ===
      "/admin/status"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const kv =
          requireKV(env);


        const status =
          await buildStatus(
            env,
            kv
          );


        return Response.json(
          status
        );

      } catch (error) {

        return Response.json(
          {
            ok: false,

            error:
              error?.message ||
              String(error)
          },
          {
            status: 500
          }
        );
      }
    }


    /*
      ADMIN RESET
    */

    if (
      path ===
      "/admin/reset"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const kv =
          requireKV(env);


        const result =
          await adminResetScheduler(
            env,
            kv
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {
            ok: false,

            error:
              error?.message ||
              String(error)
          },
          {
            status: 500
          }
        );
      }
    }


    /*
      ADMIN REQUEUE DLQ
    */

    if (
      path ===
      "/admin/requeue-dlq"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const kv =
          requireKV(env);


        const result =
          await adminRequeueDLQ(
            env,
            kv
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {
            ok: false,

            error:
              error?.message ||
              String(error)
          },
          {
            status: 500
          }
        );
      }
    }


    /*
      ADMIN SET WEBHOOK
    */

    if (
      path ===
      "/admin/set-webhook"
    ) {

      if (
        !isAdmin(
          request,
          env
        )
      ) {

        return new Response(
          "Unauthorized",
          {
            status: 401
          }
        );
      }


      try {

        const result =
          await adminSetWebhook(
            request,
            env
          );


        return Response.json(
          result
        );

      } catch (error) {

        return Response.json(
          {
            ok: false,

            error:
              error?.message ||
              String(error)
          },
          {
            status: 500
          }
        );
      }
    }


    /*
      ROOT
    */

    if (
      path ===
      "/"
    ) {

      return Response.json({

        ok: true,

        service:
          "mynote_bot",

        version:
          VERSION,

        architecture:
          "V14 Hybrid",

        cron:
          "* * * * *",

        sendInterval:
          "3–10 minutes random",

        queue:
          "KV independent queue",

        retry:
          "exponential backoff",

        dlq:
          true,

        albumSupport:
          true,

        hourlyBaleReport:
          true,

        statusEndpoint:
          "/admin/status"
      });
    }


    return new Response(
      "Not Found",
      {
        status: 404
      }
    );
  },


  /* =======================================================
     CRON
  ======================================================= */

  async scheduled(
    controller,
    env,
    ctx
  ) {

    /*
      CRITICAL:

      The previous version allowed an exception from
      KV to escape scheduled().

      That caused Cloudflare Cron to show:

      outcome: exception

      V14 catches the complete scheduled pipeline.
    */

    try {

      await processCron(
        controller,
        env
      );

    } catch (error) {

      console.error(
        JSON.stringify({
          event:
            "SCHEDULED_FATAL_ERROR",

          version:
            VERSION,

          cron:
            controller?.cron,

          scheduledTime:
            controller?.scheduledTime,

          error:
            error?.message ||
            String(error),

          stack:
            error?.stack ||
            null
        })
      );


      /*
        Do not allow a single bad Cron execution
        to become a permanently broken scheduler.

        The next Cron will execute normally.
      */

      try {

        controller?.noRetry?.();

      } catch {
        // ignored
      }
    }
  }
};