// Cloudflare Pages Function - وسيط Google Gemini API
// المسار التلقائي: /api/ai
// مع طابور وتخزين مؤقت لتحمّل الضغط العالي

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // ساعة
const MAX_CACHE = 500;
let activeRequests = 0;
const MAX_CONCURRENT = 10;

const GEMINI_MODEL = 'gemini-2.5-flash'; // النموذج المجاني السريع

function cacheKey(body) {
  try {
    const msg = JSON.stringify(body.messages);
    let hash = 0;
    for (let i = 0; i < msg.length; i++) {
      hash = ((hash << 5) - hash + msg.charCodeAt(i)) | 0;
    }
    return 'k' + hash;
  } catch { return null; }
}

function cleanCache() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.time > CACHE_TTL) cache.delete(k);
  }
  if (cache.size > MAX_CACHE) {
    const keys = [...cache.keys()].slice(0, cache.size - MAX_CACHE);
    keys.forEach(k => cache.delete(k));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// تحويل رسائل Claude لصيغة Gemini
function toGeminiFormat(messages) {
  // ندمج كل المحتوى النصي والصور في contents
  const contents = [];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'image' && block.source) {
          parts.push({
            inline_data: {
              mime_type: block.source.media_type || 'image/jpeg',
              data: block.source.data
            }
          });
        }
      }
    }
    contents.push({ role, parts });
  }
  return contents;
}

// تحويل رد Gemini لصيغة Claude (حتى يفهمها التطبيق)
function toClaudeFormat(geminiData) {
  let text = geminiData?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  // تنظيف: إزالة علامات الكود ```json ``` التي يضيفها Gemini أحياناً
  text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  return {
    content: [{ type: 'text', text }]
  };
}

export async function onRequestOptions() {
  return new Response('', { status: 200, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'أضف GEMINI_API_KEY في إعدادات Cloudflare' }),
        { status: 500, headers: CORS }
      );
    }

    // 1) التخزين المؤقت
    const key = cacheKey(body);
    if (key && cache.has(key)) {
      const cached = cache.get(key);
      if (Date.now() - cached.time < CACHE_TTL) {
        return new Response(JSON.stringify(cached.data), {
          status: 200,
          headers: { ...CORS, 'X-Cache': 'HIT' }
        });
      }
    }

    // 2) الطابور
    let waited = 0;
    while (activeRequests >= MAX_CONCURRENT && waited < 10000) {
      await sleep(250);
      waited += 250;
    }
    activeRequests++;

    try {
      // 3) تحويل الرسائل وإرسالها لـ Gemini
      const contents = toGeminiFormat(body.messages);
      const maxTokens = Math.max(body.max_tokens || 2048, 4096); // Gemini يحتاج مساحة أكبر
      // كشف هل الطلب يريد JSON (توليد أسئلة) أم نص (تلخيص)
      const wantsJson = JSON.stringify(body.messages).includes('JSON') || JSON.stringify(body.messages).includes('questions');
      const genConfig = {
        maxOutputTokens: maxTokens,
        temperature: 0.7
      };
      if (wantsJson) genConfig.responseMimeType = 'application/json';

      let response, geminiData, attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: genConfig
          })
        });

        if (response.status === 429) {
          attempts++;
          if (attempts < maxAttempts) {
            await sleep(1000 * attempts);
            continue;
          }
          return new Response(
            JSON.stringify({ error: 'ضغط عالٍ حالياً، حاول بعد لحظات', retry: true }),
            { status: 429, headers: CORS }
          );
        }
        break;
      }

      geminiData = await response.json();

      // تحقق من أخطاء Gemini
      if (geminiData.error) {
        return new Response(
          JSON.stringify({ error: { message: geminiData.error.message || 'خطأ من Gemini' } }),
          { status: response.status, headers: CORS }
        );
      }

      // 4) حوّل الرد لصيغة Claude وخزّنه
      const claudeFormat = toClaudeFormat(geminiData);

      if (response.status === 200 && key) {
        cleanCache();
        cache.set(key, { data: claudeFormat, time: Date.now() });
      }

      return new Response(JSON.stringify(claudeFormat), {
        status: 200,
        headers: { ...CORS, 'X-Cache': 'MISS' }
      });

    } finally {
      activeRequests--;
    }

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
}
