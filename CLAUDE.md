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
3. **Story Instagram** 1080×1920 (`media_type=STORIES`, dura 24h — l'API non supporta testo/link/sticker, quindi il testo è dentro l'immagine, vedi sotto)
4. **Story Facebook** 1080×1920 (stessa immagine della story IG; upload foto non pubblicata su `/photos` + `/photo_stories` — serve un upload separato perché Meta non accetta come storia una foto già usata in un post)

### Immagine story con titolo (`/api/story-image`)
Le story non usano l'URL Pollinations diretto ma `GET /api/story-image?prompt=...&title=...&sig=...`: il worker compone un PNG 720×1280 (sfondo Pollinations + gradient blu brand + `story_title` generato da Claude + "ondamente.it") con `workers-og` (satori + resvg WASM, font Inter da Google Fonts). Dettagli:
- **Limite noto (decisione 2026-07-03):** sul piano Workers Free il render supera i 10 ms di CPU e riesce ~1 volta su 3 (tipicamente la prima della giornata). Quando fallisce (503/error 1102) il cron pubblica la story con l'immagine Pollinations senza titolo (`ig_story_fallback`/`fb_story_fallback: true` nella risposta). Si è scelto di NON passare a Workers Paid ($5/mese, che renderebbe il render affidabile) — riproporre solo se il fallback diventa un problema.
- `sig` = primi 16 byte hex di SHA-256(`WORKER_SECRET:prompt:title`) — l'endpoint è pubblico (Meta deve scaricarlo) ma non renderizza immagini arbitrarie
- il PNG è cachato in `caches.default` (Meta lo scarica più volte: story FB + container IG con retry)
- il warm-up va fatto sull'URL Pollinations di sfondo, NON sull'endpoint: un worker non può fare fetch di se stesso
- la dipendenza `workers-og` richiede `npm ci` nel workflow di deploy (`deploy-worker.yml`) — wrangler bundla da `node_modules`

Ogni step è indipendente: se IG fallisce il post FB esce comunque (`ig_error`/`ig_story_error`/`fb_story_error` nella risposta). Le immagini vengono pre-scaricate dal worker ("warm-up") perché Pollinations genera al primo accesso e il fetcher di Meta andrebbe in timeout. I post IG non si possono cancellare via API (solo a mano dall'app); quelli FB sì.

## Post manuali — pagina `/publish`
`https://ondamente.leonardo-stancati.workers.dev/publish` — per i post fuori
calendario (es. lancio di una nuova funzione con creatività già pronta).
Flusso in 2 fasi con revisione umana obbligatoria:
1. password (= `WORKER_SECRET`) + immagine (JPG/PNG max 8 MB) + spunto di testo
   → `/api/custom-prepare` salva l'immagine nel KV `IMG_KV` (TTL 7 giorni,
   servita su `GET /img/{id}`: IG scarica solo da URL pubblici) e Claude propone
   caption+hashtag attenendosi al SOLO spunto
2. l'operatore corregge il testo in pagina → `/api/custom-publish` pubblica su
   FB feed + IG feed (+ story IG e FB opzionali, immagine così com'è: niente
   compositing titolo, la creatività caricata è già finita)

Note: le route sono PRIMA del check CORS (la pagina è servita dal worker,
Meta scarica `/img/`); `warmImage(null)` = no-op (il worker non può fare fetch
di se stesso, e il KV non va scaldato). IG rifiuta immagini più verticali di
4:5. **Prerequisito deploy:** `npx wrangler kv namespace create IMG_KV` e id
in `wrangler.toml` (placeholder `SOSTITUIRE_CON_ID_NAMESPACE`), senza il quale
il deploy fallisce.

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
