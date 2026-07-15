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

// NOTA (2026-07-14): la pubblicazione social quotidiana (cron FB/IG, story,
// pagina /publish) è migrata al worker dedicato "social-agent"
// (repo social-agent, area self-service su https://area.postivo.it).
// Questo worker resta solo proxy AI + Stripe + webhook.
export default {
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

  // Ping periodico a Supabase per evitare l'auto-pause del piano Free
  // (progetto sospeso dopo 7gg senza attività API). Nessuna logica di
  // business: una sola query leggera basta a resettare il timer.
  async scheduled(event, env) {
    const base = env.SUPABASE_URL;
    const key  = env.SUPABASE_SERVICE_KEY;
    await fetch(`${base}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  },
};

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

// ════ CORS ═════════════════════════════════════════════════════════
function corsHeaders(origin, isAllowed) {
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://ondamente.it',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}