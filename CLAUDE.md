# OndaMente DSA — Note per Claude Code

## Stack
- Frontend: HTML/CSS/JS puro su GitHub Pages (ondamente.it)
- Backend: Cloudflare Worker (`worker.js`) — proxy AI, Stripe
- DB/Auth: Supabase
- AI: Claude Haiku 4.5 (semplice) + Sonnet 4.6 (complesso)
- Pagamenti: Stripe one-time

## Social (migrato — 2026-07-14)
La pubblicazione social quotidiana (cron FB/IG, story, post manuali con
approvazione) NON vive più in questo worker: è gestita dal worker dedicato
**social-agent** (repo `C:\progetti\social-agent`, area self-service su
https://area.postivo.it — pagine `/pending`, `/publish`, `/foto`, hub `/area`).
Questo worker ha perso cron, route social e la dipendenza `workers-og`;
i secret `FB_PAGE_ACCESS_TOKEN`/`FB_PAGE_ID`/`WORKER_SECRET` su Cloudflare
non sono più usati (il token era comunque invalidato dal 2026-07-07).
Per token Meta, stile immagini e flusso di approvazione vedere il README
del repo social-agent.

- **Pagina Facebook:** `https://www.facebook.com/profile.php?id=1151803171347006` — icona nel footer di tutte le pagine pubbliche. Quando disponibile, aggiornare con vanity URL.
- **Instagram:** `@ondamente_dsa` (IG User ID: `17841417643234744`) — account Business collegato alla pagina FB, icona nel footer.

## Supabase keep-alive (dal 2026-07-15)
Il piano Free di Supabase sospende il progetto dopo 7gg senza attività API.
Il cron FB rimosso il 2026-07-14 (migrazione a social-agent) teneva
involontariamente vivo il DB — appena rimosso, Supabase ha ripreso a
sospenderlo. Fix: handler `scheduled` in `worker.js` (query leggera su
`profiles`) + cron `0 5 * * *` in `wrangler.toml`, solo per resettare il
timer di inattività. Nessuna logica di business.

## Deploy
- **Frontend:** push su `main` → GitHub Pages si aggiorna in automatico (~2 min CDN)
- **Worker:** push di `worker.js` o `wrangler.toml` → GitHub Actions deploya su Cloudflare
- **CSS cache:** se aggiorni `style.css`, incrementa `?v=N` nel `<link>` di `ondamente-dsa-landing.html`
- Il deploy via GitHub Actions usa il secret `CLOUDFLARE_API_TOKEN` (repo →
  Settings → Secrets → Actions): se i deploy falliscono con "Authentication
  error code 10000", rigenerarlo su Cloudflare col template "Edit Cloudflare
  Workers".

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
| `worker.js` | Cloudflare Worker (proxy AI + Stripe) |
| `schema.sql` | Schema Supabase |
| `ondamente-admin.html` | Dashboard admin (utenti, KPI, revenue) — richiede login Supabase |

## Variabili Cloudflare (Workers → Settings → Variables)
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
