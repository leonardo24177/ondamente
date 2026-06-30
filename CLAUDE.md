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

## File principali
| File | Scopo |
|---|---|
| `index.html` | Landing principale |
| `ondamente-dsa-landing.html` | Landing DSA |
| `assistente.html` | App assistente |
| `style.css` | CSS condiviso (index + dsa landing) |
| `assistente.css` | CSS app |
| `worker.js` | Cloudflare Worker |
| `schema.sql` | Schema Supabase |

## Variabili Cloudflare (Workers → Settings → Variables)
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- `FB_PAGE_ACCESS_TOKEN` — Page Access Token (da Graph API Explorer → me/accounts)
- `FB_PAGE_ID` = `1151803171347006`
- `WORKER_SECRET` = `ondamente-fb-2026`
