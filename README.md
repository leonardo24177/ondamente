# 🌊 OndaMente DSA

> L'assistente universitario AI che si adatta al tuo modo di imparare.  
> Dislessia · ADHD · Discalculia · BES · Comorbilità

---

## Struttura del repository

```
ondamente/
├── index.html                          ← Landing page principale
├── dsa.html                            ← Landing page DSA (/dsa)
├── assistente.html                     ← App assistente AI
├── ondamente-dsa-landing.html          ← Landing page alternativa
├── ondamente-admin.html                ← Pannello admin
├── ondamente-admin1.html               ← Pannello admin (v2)
├── style.css                           ← CSS landing pages
├── assistente.css                      ← CSS app assistente
├── guide/                              ← Pagine SEO cluster
│   ├── studiare-con-dislessia-universita.html
│   ├── adhd-universita-strategie.html
│   ├── discalculia-esami-universitari.html
│   ├── comorbilita-dsa-universita.html
│   └── strumenti-compensativi-dsa-legge-170.html
├── schema.sql                          ← Schema database (eseguire su Supabase)
├── worker.js                           ← Worker proxy API Anthropic + Stripe
├── sitemap.xml
├── robots.txt
├── CNAME                               ← ondamente.it
└── README.md
```

---

## Setup completo

### 1. Supabase — database e autenticazione

1. Crea un account su [supabase.com](https://supabase.com) e crea un nuovo progetto
2. Vai su **SQL Editor → New query**, incolla il contenuto di `schema.sql` e clicca **Run**
3. Vai su **Settings → API** e copia:
   - **Project URL** → `https://xxxx.supabase.co`
   - **anon public key** → `eyJh...`
4. Apri `assistente.html` e sostituisci:
   ```js
   const SB_URL = 'INSERISCI_IL_TUO_SUPABASE_URL';
   const SB_KEY = 'INSERISCI_LA_TUA_SUPABASE_ANON_KEY';
   ```

> La **anon key** è pubblica per design — è sicura nel frontend perché  
> le Row Level Security policies garantiscono che ogni utente veda solo i propri dati.

---

### 2. Cloudflare Worker — proxy API

Il Worker gestisce tre responsabilità:

- **Proxy Anthropic** — inoltra le richieste di chat nascondendo la chiave API
- **Checkout Stripe** — crea sessioni di pagamento
- **Webhook Stripe** — attiva i piani dopo il pagamento

1. Vai su [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create Worker**
2. Incolla il contenuto di `worker.js`
3. Vai su **Settings → Variables and Secrets** → aggiungi:

   | Nome | Valore |
   |---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-...` da [console.anthropic.com](https://console.anthropic.com) |
   | `SUPABASE_URL` | URL del progetto Supabase |
   | `SUPABASE_SERVICE_KEY` | Service role key di Supabase |
   | `STRIPE_SECRET_KEY` | `sk_live_...` da Stripe dashboard |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...` dopo aver configurato il webhook |

4. Copia il Worker URL e in `assistente.html` sostituisci:
   ```js
   const API_ENDPOINT = 'INSERISCI_IL_TUO_WORKER_URL/api/chat';
   ```

---

### 3. Stripe — pagamenti

Piani configurati (price ID live):

| Piano | Materie | Prezzo | Scadenza |
|---|---|---|---|
| Single | 1 | €7,99 | nessuna |
| Triple | 3 | €19,99 | 31 luglio anno accademico |
| Quintuple | 5 | €29,99 | 31 luglio anno accademico |

Configura il webhook in Stripe Dashboard → **Developers → Webhooks** puntando a:
```
https://TUO_WORKER.workers.dev/api/webhook
```
Evento da ascoltare: `checkout.session.completed`

---

### 4. GitHub Pages — hosting

1. Carica tutti i file su GitHub
2. Vai su **Settings → Pages → Source → Deploy from branch → main**
3. Il sito sarà disponibile su `https://tuonome.github.io/ondamente/`

Per il dominio `ondamente.it`, il file `CNAME` è già configurato. Imposta i DNS:

```
A     @     185.199.108.153
A     @     185.199.109.153
A     @     185.199.110.153
A     @     185.199.111.153
CNAME www   tuonome.github.io
```

---

## Tabelle Supabase

| Tabella | Descrizione |
|---|---|
| `profiles` | Profilo utente (università, corso, anno, piano, materie_remaining) |
| `subjects` | Materie con testo PDF, profilo DSA, stato pagamento e scadenza |
| `conversations` | Sessioni di chat per materia |
| `messages` | Messaggi singoli (user / assistant) |

Tutte le tabelle hanno **Row Level Security** attiva.

---

## Routing AI (worker.js)

Il Worker seleziona automaticamente il modello in base alla complessità:

| Modello | Quando |
|---|---|
| `claude-sonnet-4-6` | Domande complesse (>20 parole), modalità scaffolding/mappa |
| `claude-haiku-4-5-20251001` | Quiz, ripasso, audio, domande semplici |

---

## Social (Facebook + Instagram)

La pubblicazione social automatica (post quotidiano, story, approvazione,
post manuali) è gestita dal worker dedicato **social-agent**
(repo `social-agent`, area self-service su https://area.postivo.it) —
questo worker non pubblica più sui social dal 2026-07-14.

Esiste inoltre una routine cloud (lunedì 9:00, ora Roma) che genera 5 bozze
settimanali sul documento Google Drive "OndaMente - Piano Editoriale
Facebook": https://claude.ai/code/routines/trig_01LR2ZhRkWw3FVDsWFQioqBF

---

## Sviluppo locale

Apri `index.html` in un browser o usa Live Server (VS Code).  
Assicurati che `http://127.0.0.1:5500` sia in `ALLOWED_ORIGINS` nel worker.

---

## Licenza

© 2025 OndaMente · Made in Italy 🇮🇹
