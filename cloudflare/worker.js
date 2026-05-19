/**
 * OndaMente DSA — Cloudflare Worker
 * Proxy sicuro per l'API Anthropic: la chiave non è mai esposta nel frontend.
 *
 * SETUP:
 * 1. Vai su https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Incolla questo codice
 * 3. Settings → Variables → aggiungi secret: ANTHROPIC_API_KEY = sk-ant-...
 * 4. Copia il Worker URL e incollalo in assistente.html come API_ENDPOINT
 */

const ALLOWED_ORIGINS = [
  'https://ondamente.it',
  'https://rcqzyagyycipigemyelh.supabase.co',
  'https://www.ondamente.it',
  'http://localhost:3000',    // sviluppo locale
  'http://127.0.0.1:5500',   // Live Server VS Code
  'null',                     // file:// locale
];

export default {
  async fetch(request, env) {

    const origin = request.headers.get('Origin') || '';
    const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
                      origin.endsWith('.github.io') ||
                      origin.endsWith('.pages.dev');

    // Gestione preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(origin, isAllowed),
      });
    }

    // Solo POST su /api/chat
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/chat') {
      return new Response('Not found', { status: 404 });
    }

    if (!isAllowed) {
      return new Response('Forbidden', { status: 403 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const { messages, system, max_tokens = 1200 } = body;

    if (!messages || !Array.isArray(messages)) {
      return new Response('Missing messages', { status: 400 });
    }

    // Chiamata ad Anthropic
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens,
        system: system || '',
        messages,
      }),
    });

    const data = await anthropicRes.json();

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin, isAllowed),
      },
    });
  },
};

function corsHeaders(origin, isAllowed) {
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://ondamente.it',
  'https://rcqzyagyycipigemyelh.supabase.co',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
