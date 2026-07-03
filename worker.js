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

    // ── ROUTE: Test cron (temporaneo) ───────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/test-cron') {
      const body = await request.json().catch(() => ({}));
      if (body.secret !== env.WORKER_SECRET) return new Response('Unauthorized', { status: 401 });
      const result = await handleDailyFbPost(env);
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
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
{"caption":"testo 150-250 parole con emoji e call-to-action ondamente.it","hashtag":"#ondamente #dsauniversità #dislessia #adhd #bes più altri 10-15","image_prompt":"short English description for AI image generation, contemporary editorial flat illustration for adults, characters are Italian university students age 20-26 with mature adult features (never children or teenagers), vary the scene each day (university library, lecture hall, campus, study desk with laptop and coffee), dominant colors #2563EB blue and #F97316 orange on white background, absolutely no text or letters in image"}`,
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
  let ig = {};
  try {
    // Post nel feed: formato quadrato, stesso prompt e seed per coerenza visiva
    const igImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(image_prompt)}?width=1080&height=1080&nologo=true&model=flux&seed=42`;
    const feed = await publishIgMedia(igUserId, token, igImageUrl, { caption: message });
    ig = feed.id ? { ig_post_id: feed.id } : { ig_error: feed.error, ig_detail: feed.detail };

    // Story: stessa creatività in verticale 1080×1920 (24h, solo immagine)
    const storyImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(image_prompt)}?width=1080&height=1920&nologo=true&model=flux&seed=42`;
    const story = await publishIgMedia(igUserId, token, storyImageUrl, { media_type: 'STORIES' });
    Object.assign(ig, story.id ? { ig_story_id: story.id } : { ig_story_error: story.error, ig_story_detail: story.detail });
  } catch (e) {
    ig = { ig_error: String(e) };
  }

  return { success: true, post_id: postData.id, ...ig };
}

// Pubblica un contenuto Instagram (feed o story): pre-genera l'immagine su
// Pollinations, poi crea e pubblica il container con retry
async function publishIgMedia(igUserId, token, imageUrl, extraParams) {
  // Pollinations crea l'immagine al primo accesso (anche 30+s) e il fetcher
  // di Instagram va in timeout se non la trova già in cache
  let warmed = false;
  for (let i = 0; i < 3 && !warmed; i++) {
    try {
      const warm = await fetch(imageUrl);
      if (warm.ok && (warm.headers.get('content-type') || '').startsWith('image/')) {
        await warm.arrayBuffer();
        warmed = true;
      }
    } catch (e) { /* riprova */ }
  }

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

// ════ CORS ═════════════════════════════════════════════════════════
function corsHeaders(origin, isAllowed) {
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://ondamente.it',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}