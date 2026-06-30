# OndaMente DSA — Note per Claude Code

## Stack
- Frontend: HTML/CSS/JS puro su GitHub Pages (ondamente.it)
- Backend: Cloudflare Worker (`worker.js`) — proxy AI, Stripe, cron Facebook
- DB/Auth: Supabase
- AI: Claude Haiku 4.5 (semplice) + Sonnet 4.6 (complesso)
- Pagamenti: Stripe one-time
- Immagini AI: Pollinations.ai

## Deploy
- **Frontend:** push su `main` → GitHub Pages si aggiorna in automatico (~2 min CDN)
- **Worker:** push di `worker.js` o `wrangler.toml` → GitHub Actions deploya su Cloudflare
- **CSS cache:** se aggiorni `style.css`, incrementa `?v=N` nel `<link>` di `ondamente-dsa-landing.html`

## Test cron Facebook
```bash
curl -s -X POST https://ondamente.leonardo-stancati.workers.dev/api/test-cron \
  -H "Content-Type: application/json" \
  -d '{"secret":"ondamente-fb-2026"}'
```

## Decisioni di prodotto
- **Target:** esclusivamente studenti universitari (18-28 anni). Non espandere a liceo/medie — il posizionamento DSA universitario è il vantaggio competitivo principale.
- **Email pubblica:** `ondamente.it@gmail.com` (footer, privacy policy, link Contatti su tutte le pagine)

## File principali
| File | Scopo |
|---|---|
| `index.html` | Landing principale |
| `ondamente-dsa-landing.html` | Landing DSA |
| `assistente.html` | App assistente |
| `privacy.html` | Privacy Policy GDPR |
| `cookie-banner.js` | Banner cookie (caricato da tutte le pagine pubbliche) |
| `style.css` | CSS condiviso (index + dsa landing + privacy) |
| `assistente.css` | CSS app |
| `worker.js` | Cloudflare Worker |
| `schema.sql` | Schema Supabase |
| `ondamente-admin.html` | Dashboard admin (utenti, KPI, revenue) — richiede login Supabase |

## Social
- **Facebook:** `https://www.facebook.com/profile.php?id=1151803171347006` — icona nel footer di tutte le pagine pubbliche. Quando disponibile, aggiornare con vanity URL.
- **Instagram:** da creare (handle consigliato: `@ondamente.dsa`) — aggiungere icona footer quando pronto.

## Variabili Cloudflare (Workers → Settings → Variables)
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- `FB_PAGE_ACCESS_TOKEN` — Page Access Token (da Graph API Explorer → me/accounts)
- `FB_PAGE_ID` = `1151803171347006`
- `WORKER_SECRET` = `ondamente-fb-2026`
