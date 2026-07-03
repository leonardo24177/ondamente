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
- **Instagram:** `@ondamente_dsa` (IG User ID: `17841417643234744`) — account Business collegato alla pagina FB, icona nel footer.

## Cron social (tutti i giorni alle 9:00 ora italiana, `0 7 * * *` in wrangler.toml)
Un'unica esecuzione genera testo (Claude Haiku) + immagine (Pollinations) e pubblica:
1. **Post Facebook** 1200×630
2. **Post Instagram** 1080×1080 (stessa creatività)
3. **Story Instagram** 1080×1920 (`media_type=STORIES`, dura 24h, solo immagine — l'API non supporta testo/link/sticker)

Ogni step è indipendente: se IG fallisce il post FB esce comunque (`ig_error`/`ig_story_error` nella risposta). Le immagini vengono pre-scaricate dal worker ("warm-up") perché Pollinations genera al primo accesso e il fetcher di Meta andrebbe in timeout. I post IG non si possono cancellare via API (solo a mano dall'app); quelli FB sì.

## Immagini Facebook (Pollinations.ai)
- **Modello:** `flux` (migliore aderenza al prompt rispetto al default)
- **Seed:** `42` (fisso — stile visivo coerente tra i post)
- **Colori brand nel prompt:** `dominant colors #2563EB blue and #F97316 orange on white background`
- **Stile (dal 2026-07-03):** editoriale adulto contemporaneo, personaggi 20-26 anni con tratti adulti (mai bambini/teenager), scena variabile (biblioteca, aula, campus, scrivania) — il target è universitario
- **URL pattern:** `https://image.pollinations.ai/prompt/{prompt}?width=1200&height=630&nologo=true&model=flux&seed=42`
- Per variare lo stile cambia il seed; per testare: `curl /api/test-cron`

## Variabili Cloudflare (Workers → Settings → Variables)
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- `FB_PAGE_ACCESS_TOKEN` — Page Access Token permanente (vedi sotto)
- `FB_PAGE_ID` = `1151803171347006`
- `WORKER_SECRET` = `ondamente-fb-2026`

## Token Facebook — rigenerazione (se scade o viene revocato)
1. [Graph API Explorer](https://developers.facebook.com/tools/explorer/) → app `ondamente.it` → menu "User or Page" → seleziona la pagina OndaMente DSA con permessi `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` → copia il Page Access Token (breve durata)
2. Rendilo permanente: `GET /oauth/access_token?grant_type=fb_exchange_token&client_id={APP_ID}&client_secret={APP_SECRET}&fb_exchange_token={TOKEN}` (App ID/Secret in Impostazioni → Di base)
3. Verifica: `GET /debug_token?input_token={NUOVO_TOKEN}&access_token={APP_ID}|{APP_SECRET}` → deve dare `expires_at: 0` (mai) e type `PAGE`
4. Aggiorna `FB_PAGE_ACCESS_TOKEN` su Cloudflare → Save and Deploy → testa con `/api/test-cron`

**Note:**
- L'app Meta deve restare in **Live mode**: in Development mode i post vengono pubblicati ma sono invisibili al pubblico (li vede solo chi ha un ruolo nell'app).
- Il collegamento Instagram↔pagina va fatto **dal lato pagina FB** (profilo pagina → Impostazioni → Account collegati → Instagram), NON dal Centro account di Instagram: quello è solo condivisione e non abilita l'API.
- Il deploy del worker via GitHub Actions usa il secret `CLOUDFLARE_API_TOKEN` (repo → Settings → Secrets → Actions): se i deploy falliscono con "Authentication error code 10000", rigenerarlo su Cloudflare con il template "Edit Cloudflare Workers".
