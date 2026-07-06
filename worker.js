/**
 * OndaMente DSA — Cloudflare Worker v3
 * - Proxy Anthropic con routing dinamico Haiku/Sonnet
 * - Check limite free (25 msg/mese)
 * - Stripe Checkout + Webhook
 *
 * SECRETS da aggiungere in Cloudflare:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   STRIPE_SECRET_KEY      = sk_live_...
 *   STRIPE_WEBHOOK_SECRET  = whsec_...
 */

import { ImageResponse, loadGoogleFont } from 'workers-og';

const WORKER_URL = 'https://ondamente.leonardo-stancati.workers.dev';

const ALLOWED_ORIGINS = [
  'https://ondamente.it',
  'https://www.ondamente.it',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'null',
];

const FREE_MSG_LIMIT = 25;

const PLANS = {
  'price_1TZ9YIALVMXGZKwbgLY85Op2': { type: 'single',    subjects: 1 },  // €7,99
  'price_1TZ9YJALVMXGZKwb0aGmtSMC': { type: 'triple',    subjects: 3 },  // €19,99
  'price_1TZ9YIALVMXGZKwbXVnt9JYb': { type: 'quintuple', subjects: 5 },  // €29,99
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleDailyFbPost(env));
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
                      origin.endsWith('.github.io') ||
                      origin.endsWith('.pages.dev');

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin, isAllowed) });
    }

    const url = new URL(request.url);

    // ── ROUTE: Stripe Webhook (no CORS check — viene da Stripe) ──
    if (request.method === 'POST' && url.pathname === '/api/webhook') {
      return handleWebhook(request, env);
    }

    // ── ROUTE: Facebook Post (no CORS check — chiamata server-to-server) ──
    if (request.method === 'POST' && url.pathname === '/api/fb-post') {
      return handleFbPost(request, env);
    }

    // ── ROUTE: Immagine story composta (no CORS check — la scarica il fetcher di Meta) ──
    if (request.method === 'GET' && url.pathname === '/api/story-image') {
      return handleStoryImage(request, env);
    }

    // ── ROUTE: Test cron (temporaneo) ───────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/test-cron') {
      const body = await request.json().catch(() => ({}));
      if (body.secret !== env.WORKER_SECRET) return new Response('Unauthorized', { status: 401 });
      const result = await handleDailyFbPost(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    // ── ROUTE: Post manuali (no CORS check — la pagina è servita dal
    // worker stesso e /img/ lo scaricano i fetcher di Meta; le API sono
    // protette dal WORKER_SECRET come /api/test-cron) ──────────────────
    if (request.method === 'GET' && url.pathname === '/publish') {
      return new Response(PUBLISH_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/img/')) {
      const img = await env.IMG_KV.getWithMetadata(url.pathname.slice(5), 'arrayBuffer');
      if (!img || !img.value) return new Response('Not found', { status: 404 });
      return new Response(img.value, {
        headers: {
          'Content-Type': (img.metadata && img.metadata.ct) || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/custom-prepare') {
      return handleCustomPrepare(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/custom-publish') {
      return handleCustomPublish(request, env);
    }

    if (!isAllowed) return new Response('Forbidden', { status: 403 });

    // ── ROUTE: Checkout ──────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/checkout') {
      return handleCheckout(request, env, origin, isAllowed);
    }

    // ── ROUTE: Check subject limit ──────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/check-subject-limit') {
      return handleCheckSubjectLimit(request, env, origin, isAllowed);
    }

    // ── ROUTE: Chat ──────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChat(request, env, origin, isAllowed);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ════ FACEBOOK POST ═══════════════════════════════════════════════
async function handleFbPost(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad request', { status: 400 }); }

  const { message, secret, image_prompt } = body;

  if (!secret || secret !== env.WORKER_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!message) {
    return new Response('Missing message', { status: 400 });
  }
  if (!env.FB_PAGE_ACCESS_TOKEN) {
    return new Response('FB token not configured', { status: 500 });
  }

  const token = env.FB_PAGE_ACCESS_TOKEN;

  // Se c'è un prompt immagine, carica la foto e allega al post
  if (image_prompt) {
    const encodedPrompt = encodeURIComponent(image_prompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1200&height=630&nologo=true&model=flux&seed=42`;

    // Step 1: carica foto su Facebook (non pubblicata)
    const pageId = env.FB_PAGE_ID;
    const photoRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imageUrl, published: false, access_token: token }),
    });
    const photoData = await photoRes.json();

    if (!photoRes.ok || !photoData.id) {
      return new Response(JSON.stringify({ error: photoData }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Step 2: pubblica post con foto allegata
    const postRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        attached_media: [{ media_fbid: photoData.id }],
        access_token: token,
      }),
    });
    const postData = await postRes.json();

    if (!postRes.ok) {
      return new Response(JSON.stringify({ error: postData }), {
        status: postRes.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, post_id: postData.id }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fallback: post solo testo
  const res = await fetch(`https://graph.facebook.com/v20.0/${env.FB_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: token }),
  });
  const data = await res.json();

  if (!res.ok) {
    return new Response(JSON.stringify({ error: data }), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ success: true, post_id: data.id }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ════ CHECK SUBJECT LIMIT ═════════════════════════════════════════
async function handleCheckSubjectLimit(request, env, origin, isAllowed) {
  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad request', { status: 400 }); }

  const { user_id } = body;
  if (!user_id) return new Response('Missing user_id', { status: 400 });

  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const profileRes = await fetch(
    `${base}/rest/v1/profiles?id=eq.${user_id}&select=plan,subjects_remaining,plan_expires_at&limit=1`,
    { headers }
  );
  const profiles = await profileRes.json();
  const profile = profiles?.[0];
  const plan = profile?.plan ?? 'free';

  if (plan !== 'free') {
    if (profile.plan_expires_at && new Date(profile.plan_expires_at) < new Date()) {
      return new Response(JSON.stringify({
        allowed: false,
        reason: 'Il tuo piano è scaduto. Acquista un nuovo piano per aggiungere materie.'
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) } });
    }
    if (profile.subjects_remaining <= 0) {
      return new Response(JSON.stringify({
        allowed: false,
        reason: 'Hai esaurito le materie del tuo piano. Acquista un nuovo piano per continuarne altre.'
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) } });
    }
    return new Response(JSON.stringify({ allowed: true }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) }
    });
  }

  // Utenti free — max 1 materia
  const subjRes = await fetch(
    `${base}/rest/v1/subjects?user_id=eq.${user_id}&select=id`,
    { headers: { ...headers, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
  );
  const range = subjRes.headers.get('Content-Range') || '';
  const total = parseInt(range.split('/')[1] || '0', 10);

  if (total >= 1) {
    return new Response(JSON.stringify({
      allowed: false,
      reason: 'Con il piano gratuito puoi studiare solo 1 materia. Acquista un piano per aggiungerne altre.',
      show_upgrade: true
    }), { headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) } });
  }

  return new Response(JSON.stringify({ allowed: true }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) }
  });
}

// ════ CHAT ════════════════════════════════════════════════════════
async function handleChat(request, env, origin, isAllowed) {
  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad request', { status: 400 }); }

  const { messages, system, max_tokens = 1200, stream = false, user_id, mode } = body;
  if (!messages || !Array.isArray(messages)) {
    return new Response('Missing messages', { status: 400 });
  }

  if (user_id) {
    const accessError = await checkAccess(user_id, body.subject_id, env);
    if (accessError) {
      const code = accessError === 'EXAM_DATE_MISSING' ? 'EXAM_DATE_MISSING' : 'NO_ACCESS';
      return new Response(JSON.stringify({ error: { message: accessError, code } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) },
      });
    }
    const limitError = await checkFreeLimit(user_id, env);
    if (limitError) {
      return new Response(JSON.stringify({ error: { message: limitError, code: 'LIMIT_REACHED' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) },
      });
    }
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: selectModel(messages, mode),
      max_tokens,
      system: system || '',
      messages,
      stream,
    }),
  });

  if (stream) {
    return new Response(anthropicRes.body, {
      status: anthropicRes.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeaders(origin, isAllowed),
      },
    });
  }

  const data = await anthropicRes.json();
  return new Response(JSON.stringify(data), {
    status: anthropicRes.status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) },
  });
}

// ════ CHECKOUT ════════════════════════════════════════════════════
async function handleCheckout(request, env, origin, isAllowed) {
  let body;
  try { body = await request.json(); }
  catch { return new Response('Bad request', { status: 400 }); }

  // subject_id è opzionale: presente se l'utente sta pagando per una materia già creata
  const { price_id, user_id, user_email, subject_id, success_url, cancel_url } = body;

  if (!price_id || !user_id || !PLANS[price_id]) {
    return new Response('Invalid price', { status: 400 });
  }

  const params = new URLSearchParams({
    'payment_method_types[]': 'card',
    'line_items[0][price]': price_id,
    'line_items[0][quantity]': '1',
    'mode': 'payment',
    'customer_email': user_email || '',
    'success_url': success_url || 'https://ondamente.it/assistente.html?payment=success',
    'cancel_url': cancel_url || 'https://ondamente.it/assistente.html?payment=cancelled',
    'metadata[user_id]': user_id,
    'metadata[price_id]': price_id,
  });

  // Passa subject_id nei metadata solo se presente
  if (subject_id) params.set('metadata[subject_id]', subject_id);

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  const session = await res.json();
  if (!res.ok) {
    return new Response(JSON.stringify({ error: session.error?.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) },
    });
  }

  return new Response(JSON.stringify({ url: session.url }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) },
  });
}

// ════ WEBHOOK ══════════════════════════════════════════════════════
async function handleWebhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  let event;
  try {
    event = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`Webhook signature error: ${e.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const user_id    = session.metadata?.user_id;
    const price_id   = session.metadata?.price_id;
    const subject_id = session.metadata?.subject_id; // presente se pagamento per materia specifica
    const plan       = PLANS[price_id];

    if (user_id && plan) {
      // 1. Aggiorna il profilo utente (piano + materie rimanenti)
      await activatePlan(user_id, plan, price_id, env);

      // 2. Se c'è una subject_id, segna la materia come pagata
      if (subject_id) {
        await activateSubject(subject_id, price_id, env);
      }
    }
  }

  return new Response('ok', { status: 200 });
}

// ════ ATTIVA PIANO SU SUPABASE ═════════════════════════════════════
async function activatePlan(user_id, plan, price_id, env) {
  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  // Anno accademico: scade il 31 luglio (bundle) — single non ha plan_expires_at
  const now = new Date();
  const year = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
  const academicYearEnd = new Date(`${year}-07-31T23:59:59Z`).toISOString();

  await fetch(`${base}/rest/v1/profiles?id=eq.${user_id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      plan: plan.type,
      subjects_remaining: plan.subjects,
      plan_expires_at: plan.type === 'single' ? null : academicYearEnd,
    }),
  });
}

// ════ ATTIVA MATERIA SU SUPABASE ════════════════════════════════════
async function activateSubject(subject_id, price_id, env) {
  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };

  await fetch(`${base}/rest/v1/subjects?id=eq.${subject_id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      is_paid:      true,
      purchased_at: new Date().toISOString(),
      price_id:     price_id,
      // expires_at rimane null finché l'utente non imposta la data esame
    }),
  });
}

// ════ CHECK ACCESSO MATERIA ════════════════════════════════════════
async function checkAccess(user_id, subject_id, env) {
  if (!subject_id) return null;

  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  const [profileRes, subjectRes] = await Promise.all([
    fetch(`${base}/rest/v1/profiles?id=eq.${user_id}&select=plan,subjects_remaining,plan_expires_at&limit=1`, { headers }),
    fetch(`${base}/rest/v1/subjects?id=eq.${subject_id}&select=is_paid,expires_at,purchased_at,price_id&limit=1`, { headers }),
  ]);

  const profile = (await profileRes.json())?.[0];
  const subject = (await subjectRes.json())?.[0];

  if (!profile || !subject) return null;

  // Materia non pagata → accesso libero (gestito da checkFreeLimit)
  if (!subject.is_paid) return null;

  // Pagata ma data esame non ancora impostata → blocca con codice speciale
  if (!subject.expires_at) {
    return 'EXAM_DATE_MISSING';
  }

  // Calcola la scadenza massima in base al piano (cap giorni dall'acquisto)
  const CAP_DAYS = { single: 90, triple: 120, quintuple: 150 };
  const capDays = CAP_DAYS[profile.plan] ?? 90;
  const purchasedAt = subject.purchased_at
    ? new Date(subject.purchased_at)
    : new Date();
  const maxExpiry = new Date(purchasedAt.getTime() + capDays * 24 * 60 * 60 * 1000);

  // La scadenza effettiva è la minore tra quella impostata e il cap
  const effectiveExpiry = new Date(subject.expires_at) < maxExpiry
    ? new Date(subject.expires_at)
    : maxExpiry;

  if (effectiveExpiry < new Date()) {
    return 'Il tuo accesso per questa materia è scaduto.';
  }

  return null; // accesso ok
}

// ════ CHECK LIMITE FREE ════════════════════════════════════════════
async function checkFreeLimit(user_id, env) {
  const base = env.SUPABASE_URL;
  const key  = env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  const profileRes = await fetch(
    `${base}/rest/v1/profiles?id=eq.${user_id}&select=plan&limit=1`, { headers }
  );
  const profiles = await profileRes.json();
  const plan = profiles?.[0]?.plan ?? 'free';

  if (plan !== 'free') return null;

  const convsRes = await fetch(
    `${base}/rest/v1/conversations?user_id=eq.${user_id}&select=id`, { headers }
  );
  const convs = await convsRes.json();
  if (!Array.isArray(convs) || convs.length === 0) return null;

  const convIds = convs.map(c => `"${c.id}"`).join(',');
  const startOfMonth = new Date();
  startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

  const countRes = await fetch(
    `${base}/rest/v1/messages?role=eq.user&created_at=gte.${startOfMonth.toISOString()}&conversation_id=in.(${convIds})&select=id`,
    { headers: { ...headers, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } }
  );

  const range = countRes.headers.get('Content-Range') || '';
  const total = parseInt(range.split('/')[1] || '0', 10);

  if (total >= FREE_MSG_LIMIT) {
    return `Hai usato tutti i 25 messaggi gratuiti del mese.`;
  }
  return null;
}

// ════ ROUTING MODELLO ══════════════════════════════════════════════
function selectModel(messages, mode) {
  const HAIKU  = 'claude-haiku-4-5-20251001';
  const SONNET = 'claude-sonnet-4-6';

  if (['scaffolding', 'mappa'].includes(mode)) return SONNET;
  if (['quiz', 'ripasso', 'audio'].includes(mode)) return HAIKU;

  const lastMsg = messages[messages.length - 1]?.content || '';
  const wordCount = lastMsg.trim().split(/\s+/).length;
  const complexSignals = [
    /perch[eé]/i, /come mai/i, /differenza tra/i, /confronta/i,
    /analizza/i, /spiega.*dettagl/i, /approfond/i, /relazione tra/i,
    /collega/i, /dimostr/i, /argomenta/i, /criticamente/i,
    /implicazion/i, /conseguenz/i,
  ];

  const isComplex = wordCount > 20 ||
    complexSignals.some(re => re.test(lastMsg)) ||
    messages.length > 6;

  return isComplex ? SONNET : HAIKU;
}

// ════ VERIFICA FIRMA STRIPE ════════════════════════════════════════
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) throw new Error('Missing stripe-signature header');

  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) throw new Error('Invalid signature format');

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed !== signature) throw new Error('Signature mismatch');

  const diff = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (diff > 300) throw new Error('Timestamp too old');

  return JSON.parse(payload);
}

// ════ DAILY FACEBOOK POST (Cron) ══════════════════════════════════
async function handleDailyFbPost(env) {
  const today = new Date().toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });

  // 1. Genera contenuto con Claude Haiku
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'Rispondi SOLO con un oggetto JSON valido, senza markdown, senza spiegazioni.',
      messages: [{
        role: 'user',
        content: `Genera un post Facebook per OndaMente DSA (ondamente.it) — app AI per studenti universitari italiani con DSA (Dislessia, ADHD, Discalculia, BES). Brand voice: empatico, incoraggiante, mai pietistico. 80% contenuto educativo, 20% promozionale. Data: ${today}.

Restituisci SOLO questo JSON:
{"caption":"testo 150-250 parole con emoji e call-to-action ondamente.it","hashtag":"#ondamente #dsauniversità #dislessia #adhd #bes più altri 10-15","story_title":"titolo italiano per la story, max 7 parole, incisivo, senza emoji e senza hashtag","image_prompt":"short English description for AI image generation, contemporary editorial flat illustration for adults, characters are Italian university students age 20-26 with mature adult features (never children or teenagers), vary the scene each day (university library, lecture hall, campus, study desk with laptop and coffee), dominant colors #2563EB blue and #F97316 orange on white background, absolutely no text or letters in image"}`,
      }],
    }),
  });

  if (!claudeRes.ok) return { error: 'claude_failed', status: claudeRes.status };
  const claudeData = await claudeRes.json();
  let text = (claudeData.content?.[0]?.text || '').trim()
    .replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let post;
  try { post = JSON.parse(text); } catch (e) { return { error: 'json_parse_failed', text }; }

  const { caption, hashtag, image_prompt } = post;
  if (!caption || !image_prompt) return { error: 'missing_fields', post };

  // 2. Carica immagine su Facebook (non pubblicata)
  const token = env.FB_PAGE_ACCESS_TOKEN;
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(image_prompt)}?width=1200&height=630&nologo=true&model=flux&seed=42`;

  const pageId = env.FB_PAGE_ID;
  const photoRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: imageUrl, published: false, access_token: token }),
  });
  const photoData = await photoRes.json();
  if (!photoRes.ok || !photoData.id) return { error: 'photo_upload_failed', photoData };

  // 3. Pubblica post con immagine
  const message = caption + (hashtag ? '\n\n' + hashtag : '');
  const postRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      attached_media: [{ media_fbid: photoData.id }],
      access_token: token,
    }),
  });
  const postData = await postRes.json();
  if (!postRes.ok) return { error: 'post_failed', postData };

  // 4. Cross-post su Instagram (@ondamente_dsa) — non blocca il post FB se fallisce
  const igUserId = env.IG_USER_ID || '17841417643234744';
  // Story IG + FB: sfondo Pollinations verticale 1080×1920 + titolo sovraimpresso
  // dal worker stesso (/api/story-image). A Meta si passa l'URL dell'endpoint;
  // il warm-up però va fatto sull'URL Pollinations (il worker non può fare
  // fetch di se stesso) — sarà satori a scaricare lo sfondo, già in cache.
  const storyTitle = (post.story_title || 'OndaMente DSA').trim();
  const storyBgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(image_prompt)}?width=720&height=1280&nologo=true&model=flux&seed=42`;
  const storyImageUrl = `${WORKER_URL}/api/story-image?prompt=${encodeURIComponent(image_prompt)}&title=${encodeURIComponent(storyTitle)}&sig=${await storySig(env, image_prompt, storyTitle)}`;
  let ig = {};
  try {
    // Post nel feed: formato quadrato, stesso prompt e seed per coerenza visiva
    const igImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(image_prompt)}?width=1080&height=1080&nologo=true&model=flux&seed=42`;
    const feed = await publishIgMedia(igUserId, token, igImageUrl, { caption: message });
    ig = feed.id ? { ig_post_id: feed.id } : { ig_error: feed.error, ig_detail: feed.detail };

    // Story: creatività verticale con titolo (24h). Se il render del worker
    // fallisce (limiti CPU), fallback sull'immagine Pollinations senza titolo
    let story = await publishIgMedia(igUserId, token, storyImageUrl, { media_type: 'STORIES' }, storyBgUrl);
    let igStoryFallback = false;
    if (!story.id) {
      igStoryFallback = true;
      story = await publishIgMedia(igUserId, token, storyBgUrl, { media_type: 'STORIES' });
    }
    Object.assign(ig, story.id
      ? { ig_story_id: story.id, ...(igStoryFallback && { ig_story_fallback: true }) }
      : { ig_story_error: story.error, ig_story_detail: story.detail });
  } catch (e) {
    ig = { ig_error: String(e) };
  }

  // 5. Story Facebook — non blocca il resto se fallisce. Usa la stessa
  // immagine verticale della story IG (a questo punto già in cache su
  // Pollinations). Serve un upload separato: Meta non accetta come storia
  // una foto già usata in un post pubblicato.
  let fbStory = {};
  try {
    await warmImage(storyBgUrl); // no-op se già in cache (fatto dallo step IG)
    // Prima l'immagine con titolo; se il render fallisce, quella senza
    for (const [candidateUrl, fallback] of [[storyImageUrl, false], [storyBgUrl, true]]) {
      const storyPhotoRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: candidateUrl, published: false, access_token: token }),
      });
      const storyPhotoData = await storyPhotoRes.json();
      if (!storyPhotoRes.ok || !storyPhotoData.id) {
        fbStory = { fb_story_error: 'fb_story_photo_failed', fb_story_detail: storyPhotoData };
        continue;
      }
      const storyRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photo_stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_id: storyPhotoData.id, access_token: token }),
      });
      const storyData = await storyRes.json();
      if (storyRes.ok && storyData.success) {
        fbStory = { fb_story_id: storyData.post_id, ...(fallback && { fb_story_fallback: true }) };
        break;
      }
      fbStory = { fb_story_error: 'fb_story_failed', fb_story_detail: storyData };
    }
  } catch (e) {
    fbStory = { fb_story_error: String(e) };
  }

  return { success: true, post_id: postData.id, ...ig, ...fbStory };
}

// Pollinations crea l'immagine al primo accesso (anche 30+s) e il fetcher
// di Meta va in timeout se non la trova già in cache: pre-scarica con retry.
// Con null il warm-up è saltato (immagini già pronte, es. /img/ dal KV, che
// il worker comunque non potrebbe scaricare: niente fetch verso se stesso)
async function warmImage(imageUrl) {
  if (!imageUrl) return;
  for (let i = 0; i < 3; i++) {
    try {
      const warm = await fetch(imageUrl);
      if (warm.ok && (warm.headers.get('content-type') || '').startsWith('image/')) {
        await warm.arrayBuffer();
        return;
      }
    } catch (e) { /* riprova */ }
  }
}

// Pubblica un contenuto Instagram (feed o story): pre-genera l'immagine,
// poi crea e pubblica il container con retry. warmUrl serve quando l'URL
// da pubblicare è l'endpoint /api/story-image: si scalda solo lo sfondo
// Pollinations, perché il worker non può fare fetch di se stesso.
async function publishIgMedia(igUserId, token, imageUrl, extraParams, warmUrl = imageUrl) {
  await warmImage(warmUrl);

  let containerData = null;
  for (let i = 0; i < 3; i++) {
    const containerRes = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, access_token: token, ...extraParams }),
    });
    containerData = await containerRes.json();
    if (containerRes.ok && containerData.id) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!containerData?.id) return { error: 'container_failed', detail: containerData };

  // Il container può impiegare qualche secondo a processare l'immagine
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    const pubRes = await fetch(`https://graph.facebook.com/v20.0/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerData.id, access_token: token }),
    });
    const pubData = await pubRes.json();
    if (pubRes.ok && pubData.id) return { id: pubData.id };
    lastErr = pubData;
    await new Promise(r => setTimeout(r, 5000));
  }
  return { error: 'publish_failed', detail: lastErr };
}

// ════ STORY IMAGE ══════════════════════════════════════════════════
// Compone l'immagine story 1080×1920: sfondo Pollinations + titolo e
// "ondamente.it" sovraimpressi (satori + resvg via workers-og). Il cron
// genera l'URL firmato e lo passa a Meta, che scarica il PNG da qui.

// Firma anti-abuso: l'endpoint è pubblico (Meta deve poterlo scaricare),
// ma senza sig valida non renderizza immagini arbitrarie
async function storySig(env, prompt, title) {
  const data = new TextEncoder().encode(`${env.WORKER_SECRET}:${prompt}:${title}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

let interFont = null; // cache per-isolate del font (Google Fonts)

async function handleStoryImage(request, env) {
  const url = new URL(request.url);
  const prompt = url.searchParams.get('prompt') || '';
  const title = url.searchParams.get('title') || '';
  const sig = url.searchParams.get('sig') || '';
  if (!prompt || !title || sig !== await storySig(env, prompt, title)) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Meta scarica l'immagine più volte (story FB + container IG con retry):
  // renderizza una volta sola e servi dalla cache
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  // 720×1280 e non 1080×1920: la rasterizzazione resvg a piena risoluzione
  // supera i limiti di risorse del worker (error 1102); Meta scala comunque
  const bg = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=720&height=1280&nologo=true&model=flux&seed=42`;
  if (!interFont) interFont = await loadGoogleFont({ family: 'Inter', weight: 700 });

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `
    <div style="display:flex; flex-direction:column; width:720px; height:1280px; position:relative;">
      <img src="${bg}" width="720" height="1280" style="position:absolute; top:0; left:0; object-fit:cover;" />
      <div style="display:flex; flex-direction:column; margin-top:auto; padding:130px 40px 110px; background:linear-gradient(to bottom, rgba(30,58,138,0), rgba(30,58,138,0.55) 35%, rgba(30,58,138,0.97));">
        <div style="display:flex; font-size:46px; font-weight:700; color:#FFFFFF; line-height:1.2; text-shadow: 0 2px 10px rgba(0,0,0,0.45);">${esc(title)}</div>
        <div style="display:flex; font-size:28px; font-weight:700; color:#F97316; margin-top:20px; text-shadow: 0 2px 8px rgba(0,0,0,0.4);">ondamente.it</div>
      </div>
    </div>`;

  const img = new ImageResponse(html, {
    width: 720,
    height: 1280,
    fonts: [{ name: 'Inter', data: interFont, weight: 700, style: 'normal' }],
  });
  const body = await img.arrayBuffer();
  const res = new Response(body, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
  await cache.put(request, res.clone());
  return res;
}

// ════ POST MANUALI (pagina /publish) ═══════════════════════════════

function jsonPub(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Fase 1: riceve multipart {secret, spunto, image}, salva l'immagine nel
// KV IMG_KV (scade dopo 7 giorni) e chiede a Claude una proposta di
// caption basata sullo spunto. NON pubblica nulla: restituisce testo +
// image_id che l'operatore rivede nella pagina prima della fase 2.
async function handleCustomPrepare(request, env) {
  let form;
  try { form = await request.formData(); } catch (e) { return jsonPub({ error: 'bad_form' }, 400); }
  if (form.get('secret') !== env.WORKER_SECRET) return jsonPub({ error: 'unauthorized' }, 401);

  const spunto = String(form.get('spunto') || '').trim();
  const image = form.get('image');
  if (!spunto) return jsonPub({ error: 'missing_spunto' }, 400);
  if (!image || typeof image === 'string' || !image.size) return jsonPub({ error: 'missing_image' }, 400);
  const ct = image.type || '';
  if (ct !== 'image/jpeg' && ct !== 'image/png') {
    return jsonPub({ error: 'bad_image_type', detail: 'Formati accettati: JPG o PNG' }, 400);
  }
  if (image.size > 8 * 1024 * 1024) {
    return jsonPub({ error: 'image_too_big', detail: 'Dimensione massima: 8 MB' }, 400);
  }

  const imageId = crypto.randomUUID();
  await env.IMG_KV.put(imageId, await image.arrayBuffer(), {
    expirationTtl: 7 * 24 * 3600,
    metadata: { ct },
  });

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'Rispondi SOLO con un oggetto JSON valido, senza markdown, senza spiegazioni.',
      messages: [{
        role: 'user',
        content: `Scrivi un post Facebook per OndaMente DSA (ondamente.it) — app AI per studenti universitari italiani con DSA (Dislessia, ADHD, Discalculia, BES). Brand voice: empatico, incoraggiante, mai pietistico.

NON scegliere tu l'argomento: l'operatore fornisce lo spunto per un post
specifico (es. il lancio di una nuova funzione o un annuncio) e l'immagine è
già pronta, caricata da lui. Attieniti fedelmente allo spunto: non aggiungere
dati, nomi, prezzi o date che non vi compaiano (oltre a ondamente.it come
call-to-action). Il testo verrà riletto e approvato dall'operatore prima
della pubblicazione.

Spunto dell'operatore:
"""
${spunto}
"""

Restituisci SOLO questo JSON:
{"caption":"testo 100-200 parole con emoji e call-to-action ondamente.it","hashtag":"#ondamente #dsauniversità #dislessia #adhd #bes più altri pertinenti"}`,
      }],
    }),
  });

  if (!claudeRes.ok) return jsonPub({ error: 'claude_failed', status: claudeRes.status }, 502);
  const claudeData = await claudeRes.json();
  const text = (claudeData.content?.[0]?.text || '').trim()
    .replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let post;
  try { post = JSON.parse(text); } catch (e) { return jsonPub({ error: 'json_parse_failed', text }, 502); }
  if (!post.caption) return jsonPub({ error: 'missing_fields', post }, 502);

  return jsonPub({ image_id: imageId, caption: post.caption, hashtag: post.hashtag || '' });
}

// Fase 2: riceve JSON {secret, image_id, message, story} e pubblica il
// testo approvato con l'immagine caricata su FB feed + IG feed (+ story
// IG e FB se richiesta, con l'immagine così com'è: niente compositing
// del titolo, la creatività caricata è già finita). Stessa logica del
// cron: gli errori IG/story non bloccano il post FB già riuscito.
async function handleCustomPublish(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  if (body.secret !== env.WORKER_SECRET) return jsonPub({ error: 'unauthorized' }, 401);

  const imageId = String(body.image_id || '');
  const message = String(body.message || '').trim();
  if (!imageId || !message) return jsonPub({ error: 'missing_fields' }, 400);

  const img = await env.IMG_KV.getWithMetadata(imageId, 'arrayBuffer');
  if (!img || !img.value) {
    return jsonPub({ error: 'img_not_found', detail: 'Immagine scaduta o mai caricata: ripetere la fase 1' }, 404);
  }

  const token = env.FB_PAGE_ACCESS_TOKEN;
  const pageId = env.FB_PAGE_ID;
  const imageUrl = `${WORKER_URL}/img/${imageId}`;

  const photoRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: imageUrl, published: false, access_token: token }),
  });
  const photoData = await photoRes.json();
  if (!photoRes.ok || !photoData.id) return jsonPub({ error: 'fb_photo_failed', photoData }, 502);

  const postRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      attached_media: [{ media_fbid: photoData.id }],
      access_token: token,
    }),
  });
  const postData = await postRes.json();
  if (!postRes.ok) return jsonPub({ error: 'fb_post_failed', postData }, 502);

  const igUserId = env.IG_USER_ID || '17841417643234744';
  let ig = {};
  try {
    // warmUrl null: l'immagine è nel KV, servita all'istante (e il worker
    // non può comunque fare fetch di se stesso)
    const feed = await publishIgMedia(igUserId, token, imageUrl, { caption: message }, null);
    ig = feed.id ? { ig_post_id: feed.id } : { ig_error: feed.error, ig_detail: feed.detail };

    if (body.story) {
      const story = await publishIgMedia(igUserId, token, imageUrl, { media_type: 'STORIES' }, null);
      Object.assign(ig, story.id ? { ig_story_id: story.id } : { ig_story_error: story.error, ig_story_detail: story.detail });
    }
  } catch (e) {
    ig = { ig_error: String(e) };
  }

  // Storia Facebook: upload separato, Meta non accetta come storia una
  // foto già usata in un post pubblicato
  let fbStory = {};
  if (body.story) {
    try {
      const storyPhotoRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: imageUrl, published: false, access_token: token }),
      });
      const storyPhotoData = await storyPhotoRes.json();
      if (storyPhotoRes.ok && storyPhotoData.id) {
        const storyRes = await fetch(`https://graph.facebook.com/v20.0/${pageId}/photo_stories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_id: storyPhotoData.id, access_token: token }),
        });
        const storyData = await storyRes.json();
        fbStory = storyRes.ok && storyData.success
          ? { fb_story_id: storyData.post_id }
          : { fb_story_error: 'fb_story_failed', fb_story_detail: storyData };
      } else {
        fbStory = { fb_story_error: 'fb_story_photo_failed', fb_story_detail: storyPhotoData };
      }
    } catch (e) {
      fbStory = { fb_story_error: String(e) };
    }
  }

  return jsonPub({ success: true, post_id: postData.id, ...ig, ...fbStory });
}

const PUBLISH_PAGE = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Post manuale — OndaMente</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #1c1e21; padding: 20px 12px 60px; }
  .box { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.15); padding: 24px; }
  h1 { font-size: 20px; color: #2563EB; margin-bottom: 4px; }
  .sub { font-size: 13px; color: #65676b; margin-bottom: 20px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 5px; }
  input[type=password], textarea { width: 100%; border: 1px solid #ccd0d5; border-radius: 6px; padding: 9px 10px; font-size: 14px; font-family: inherit; }
  textarea { resize: vertical; }
  input[type=file] { font-size: 13px; }
  .hint { font-size: 12px; color: #65676b; margin-top: 4px; line-height: 1.4; }
  button { margin-top: 18px; width: 100%; background: #2563EB; color: #fff; border: 0; border-radius: 6px; padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.publish { background: #1a7f37; }
  #preview { max-width: 100%; border-radius: 6px; margin-top: 10px; display: none; }
  #step2 { display: none; border-top: 1px solid #e4e6eb; margin-top: 24px; padding-top: 18px; }
  .chk { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-top: 14px; }
  .chk input { width: auto; }
  #esito { margin-top: 16px; font-size: 13.5px; line-height: 1.5; padding: 12px; border-radius: 6px; display: none; white-space: pre-wrap; }
  #esito.ok { display: block; background: #e6f4ea; color: #1a7f37; }
  #esito.err { display: block; background: #fce8e6; color: #c5221f; }
</style>
</head>
<body>
<div class="box">
  <h1>Post manuale</h1>
  <div class="sub">OndaMente DSA — carica un'immagine e uno spunto: l'AI propone
  il testo, tu lo correggi e pubblichi su Facebook e Instagram.</div>

  <label>Password</label>
  <input type="password" id="secret" autocomplete="current-password"/>

  <label>Immagine (JPG o PNG, max 8 MB)</label>
  <input type="file" id="image" accept="image/jpeg,image/png"/>
  <div class="hint">Per Instagram usare un'immagine quadrata o orizzontale (le immagini
  più alte del formato 4:5 vengono rifiutate da Instagram; su Facebook passano comunque).</div>
  <img id="preview" alt=""/>

  <label>Spunto per il testo</label>
  <textarea id="spunto" rows="5" placeholder="Es.: da lunedì 20 è disponibile la nuova funzione ...; per tutti gli utenti su ondamente.it"></textarea>
  <div class="hint">Scrivi i fatti: cosa, chi, da quando. L'AI usa SOLO ciò che scrivi qui
  (non inventa nomi, prezzi o date).</div>

  <button id="btnGenera">1 · Genera il testo</button>

  <div id="step2">
    <label>Testo del post — rileggi e correggi prima di pubblicare</label>
    <textarea id="messaggio" rows="12"></textarea>
    <div class="chk">
      <input type="checkbox" id="story" checked/>
      <label for="story" style="margin:0">Pubblica anche come storia (Instagram + Facebook)</label>
    </div>
    <button id="btnPubblica" class="publish">2 · Pubblica ORA su Facebook e Instagram</button>
    <div class="hint">La pubblicazione è immediata. I post Instagram non si possono
    cancellare via API: eventuali errori vanno corretti a mano dall'app.</div>
  </div>

  <div id="esito"></div>
</div>
<script>
  var imageId = null;
  var $ = function (id) { return document.getElementById(id); };

  $('image').addEventListener('change', function () {
    var f = this.files[0];
    if (!f) { $('preview').style.display = 'none'; return; }
    $('preview').src = URL.createObjectURL(f);
    $('preview').style.display = 'block';
  });

  function esito(msg, ok) {
    var e = $('esito');
    e.textContent = msg;
    e.className = ok ? 'ok' : 'err';
    e.style.display = msg ? 'block' : 'none';
    if (msg) e.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('btnGenera').addEventListener('click', async function () {
    var f = $('image').files[0];
    if (!$('secret').value) return esito('Inserisci la password.', false);
    if (!f) return esito("Scegli l'immagine da pubblicare.", false);
    if (!$('spunto').value.trim()) return esito('Scrivi lo spunto per il testo.', false);

    this.disabled = true;
    this.textContent = 'Generazione in corso…';
    esito('', true);

    var fd = new FormData();
    fd.append('secret', $('secret').value);
    fd.append('spunto', $('spunto').value);
    fd.append('image', f);

    try {
      var res = await fetch('/api/custom-prepare', { method: 'POST', body: fd });
      var data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || res.status);
      imageId = data.image_id;
      $('messaggio').value = data.caption + (data.hashtag ? '\\n\\n' + data.hashtag : '');
      $('step2').style.display = 'block';
      $('messaggio').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      esito('Errore nella generazione: ' + err.message, false);
    }
    this.disabled = false;
    this.textContent = '1 · Genera il testo';
  });

  $('btnPubblica').addEventListener('click', async function () {
    if (!imageId || !$('messaggio').value.trim()) return esito('Genera prima il testo.', false);
    this.disabled = true;
    this.textContent = 'Pubblicazione in corso…';

    try {
      var res = await fetch('/api/custom-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: $('secret').value,
          image_id: imageId,
          message: $('messaggio').value,
          story: $('story').checked,
        }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || res.status);
      var righe = ['✅ Pubblicato su Facebook (id ' + data.post_id + ')'];
      righe.push(data.ig_post_id ? '✅ Pubblicato su Instagram (id ' + data.ig_post_id + ')'
                                 : '⚠️ Instagram feed non pubblicato: ' + JSON.stringify(data.ig_detail || data.ig_error || ''));
      if ($('story').checked) {
        righe.push(data.ig_story_id ? '✅ Storia Instagram pubblicata'
                                    : '⚠️ Storia Instagram non pubblicata: ' + JSON.stringify(data.ig_story_detail || data.ig_story_error || ''));
        righe.push(data.fb_story_id ? '✅ Storia Facebook pubblicata'
                                    : '⚠️ Storia Facebook non pubblicata: ' + JSON.stringify(data.fb_story_detail || data.fb_story_error || ''));
      }
      esito(righe.join('\\n'), true);
    } catch (err) {
      esito('Errore nella pubblicazione: ' + err.message, false);
    }
    this.disabled = false;
    this.textContent = '2 · Pubblica ORA su Facebook e Instagram';
  });
</script>
</body>
</html>`;

// ════ CORS ═════════════════════════════════════════════════════════
function corsHeaders(origin, isAllowed) {
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://ondamente.it',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}