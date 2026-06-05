// Cloudflare Pages Function - وسيط Claude API
// المسار التلقائي: /api/ai
// مع طابور وتخزين مؤقت لتحمّل الضغط العالي

// تخزين مؤقت (يدوم خلال عمر الـ Worker)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // ساعة
const MAX_CACHE = 500;
let activeRequests = 0;
const MAX_CONCURRENT = 10;

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

// معالجة طلبات OPTIONS (CORS preflight)
export async function onRequestOptions() {
  return new Response('', { status: 200, headers: CORS });
}

// معالجة طلبات POST
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const apiKey = env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: 'أضف ANTHROPIC_API_KEY في إعدادات Cloudflare' }),
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
      // 3) الاستدعاء مع إعادة المحاولة عند 429
      let response, data, attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: body.model || 'claude-sonnet-4-6',
            max_tokens: body.max_tokens || 1500,
            messages: body.messages
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

      data = await response.json();

      // 4) خزّن الناجح
      if (response.status === 200 && key && !data.error) {
        cleanCache();
        cache.set(key, { data, time: Date.now() });
      }

      return new Response(JSON.stringify(data), {
        status: response.status,
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
