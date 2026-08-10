// ========== MyNote Bot v1.0 - Mirror & Enhance ==========

// تنظیمات ثابت
const SIGNATURE_TEXT = "\n\n📌 منبع: @" + (typeof globalThis.DEST_CHANNEL_USERNAME !== 'undefined' ? globalThis.DEST_CHANNEL_USERNAME : 'MyChannel');

// لیست کلمات کلیدی برای تشخیص موضوع و افزودن ایموجی
const EMOJI_MAP = {
  'خبر': '📰', 'اخبار': '📰', 'فوری': '🚨', 'مهم': '⚠️',
  'تکنولوژی': '💻', 'فناوری': '💻', 'گجت': '📱', 'هوش مصنوعی': '🤖',
  'ورزش': '⚽', 'فوتبال': '⚽', 'بسکتبال': '🏀', 'کشتی': '🤼',
  'هنر': '🎨', 'موسیقی': '🎵', 'فیلم': '🎬', 'سینما': '🎥',
  'سلامت': '🍎', 'پزشکی': '🩺', 'دارو': '💊', 'ورزشی': '🏃',
  'اقتصاد': '💰', 'بورس': '📈', 'طلا': '🪙', 'دلار': '💵',
  'آموزش': '📚', 'درس': '📝', 'دانشگاه': '🎓', 'مدرسه': '🏫',
  'طنز': '😂', 'جوک': '😹', 'خنده': '😆', 'سرگرمی': '🎉',
  'عشق': '❤️', 'احساسی': '💔', 'روانشناسی': '🧠',
  'طبیعت': '🌿', 'گردشگری': '✈️', 'سفر': '🧳',
  'غذا': '🍕', 'آشپزی': '👨‍🍳', 'رستوران': '🍽️'
};

// تابع کمکی برای ارسال درخواست به API بله
async function baleApi(method, data) {
  const token = globalThis.BALE_BOT_TOKEN;
  if (!token) return null;
  const url = `https://tapi.bale.ai/bot${token}/${method}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await response.json();
  } catch (e) {
    console.error('API Error:', e);
    return null;
  }
}

// تابع پردازش متن: حذف لینک/آیدی، افزودن ایموجی، تولید عنوان
function processText(text, isCaption = false) {
  if (!text) return '';

  let processed = text;

  // 1. حذف لینک‌ها و آیدی‌ها
  // حذف لینک‌های http/https
  processed = processed.replace(/https?:\/\/[^\s]+/g, '');
  // حذف آیدی‌های @username (اما نه اگر بخشی از کلمه باشد)
  processed = processed.replace(/@[a-zA-Z0-9_]+/g, '');
  
  // تمیزکاری فاصله‌های اضافی
  processed = processed.replace(/\s+/g, ' ').trim();

  // 2. افزودن ایموجی مرتبط (اگر کمتر از 2 ایموجی دارد)
  const emojiCount = (processed.match(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu) || []).length;
  
  if (emojiCount < 2) {
    let addedEmojis = new Set();
    for (const [key, emoji] of Object.entries(EMOJI_MAP)) {
      if (processed.includes(key) && !addedEmojis.has(emoji)) {
        processed = emoji + ' ' + processed;
        addedEmojis.add(emoji);
        if (addedEmojis.size >= 2) break; // حداکثر 2 ایموجی اضافه کن
      }
    }
  }

  // 3. تولید عنوان جذاب (Hook) اگر متن کوتاه است یا عنوان ندارد
  // فرض می‌کنیم اگر متن کمتر از 100 کاراکتر است یا با نقطه شروع نمی‌شود، نیاز به تیتر دارد
  if (processed.length < 100 || !processed.startsWith('.')) {
    const hooks = [
      "🔥 داغ‌ترین خبر:",
      "✨ نکته مهم:",
      "💡 آیا می‌دانستید؟",
      "🚀 فرصت ویژه:",
      "📢 توجه کنید:"
    ];
    // انتخاب تصادفی یک هوک
    const randomHook = hooks[Math.floor(Math.random() * hooks.length)];
    processed = `${randomHook}\n\n${processed}`;
  }

  // 4. افزودن امضای کانال مقصد
  // جایگزینی لینک‌های حذف شده با آیدی کانال مقصد (اختیاری - اینجا فقط امضا می‌زنیم)
  const destUsername = globalThis.DEST_CHANNEL_USERNAME || 'MyChannel';
  const signature = `\n\n📌 منبع: @${destUsername}`;
  
  // جلوگیری از تکرار امضا اگر قبلاً بوده
  if (!processed.includes(signature)) {
    processed += signature;
  }

  return processed.trim();
}

export default {
  async fetch(request, env, ctx) {
    // تنظیم متغیرهای محیطی برای استفاده در توابع دیگر
    globalThis.BALE_BOT_TOKEN = env.BALE_BOT_TOKEN;
    globalThis.SOURCE_CHANNEL_ID = env.SOURCE_CHANNEL_ID;
    globalThis.DEST_CHANNEL_ID = env.DEST_CHANNEL_ID;
    globalThis.DEST_CHANNEL_USERNAME = env.DEST_CHANNEL_USERNAME;

    if (request.method === 'POST') {
      try {
        const update = await request.json();
        
        // بررسی اینکه آیا آپدیت از کانال منبع آمده است
        if (update.channel_post && update.channel_post.chat.id.toString() === env.SOURCE_CHANNEL_ID) {
          const post = update.channel_post;
          const destChatId = env.DEST_CHANNEL_ID;

          let sendMethod = '';
          let payload = { chat_id: destChatId };

          // تشخیص نوع محتوا و آماده‌سازی Payload
          if (post.text) {
            // فقط متن
            sendMethod = 'sendMessage';
            payload.text = processText(post.text);
            payload.parse_mode = 'HTML'; // یا Markdown اگر نیاز باشد
          } 
          else if (post.photo) {
            // عکس (آخرین سایز را انتخاب می‌کنیم که باکیفیت‌ترین است)
            const photo = post.photo[post.photo.length - 1];
            sendMethod = 'sendPhoto';
            payload.photo = photo.file_id;
            payload.caption = processText(post.caption || '', true);
          } 
          else if (post.video) {
            // ویدیو
            sendMethod = 'sendVideo';
            payload.video = post.video.file_id;
            payload.caption = processText(post.caption || '', true);
          } 
          else if (post.document) {
            // فایل
            sendMethod = 'sendDocument';
            payload.document = post.document.file_id;
            payload.caption = processText(post.caption || '', true);
          } 
          else if (post.animation) {
            // گیف
            sendMethod = 'sendAnimation';
            payload.animation = post.animation.file_id;
            payload.caption = processText(post.caption || '', true);
          } 
          else if (post.sticker) {
            // استیکر (استیکر کپشن ندارد)
            sendMethod = 'sendSticker';
            payload.sticker = post.sticker.file_id;
          } 
          else {
            // سایر موارد (صدا و ...)
            console.log('Unsupported message type');
            return new Response('OK');
          }

          // ارسال به کانال مقصد
          if (sendMethod) {
            await baleApi(sendMethod, payload);
          }
        }
      } catch (e) {
        console.error('Processing error:', e);
      }
    }

    return new Response('OK');
  }
};