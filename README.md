# 🌊 OndaMente DSA

> L'assistente universitario AI che si adatta al tuo modo di imparare.  
> Dislessia · ADHD · Discalculia · BES · Comorbilità

---

## Struttura del repository

```
ondamente/
├── index.html              ← Landing page
├── assistente.html         ← App assistente
├── supabase/
│   └── schema.sql          ← Schema database (eseguire su Supabase)
├── cloudflare/
│   └── worker.js           ← Worker proxy API Anthropic
└── README.md
```

---

## Setup completo (15 minuti)

### 1. Supabase — database e autenticazione

1. Crea un account su [supabase.com](https://supabase.com) e crea un nuovo progetto
2. Vai su **SQL Editor → New query**, incolla il contenuto di `supabase/schema.sql` e clicca **Run**
3. Vai su **Settings → API** e copia:
   - **Project URL** → `https://xxxx.supabase.co`
   - **anon public key** → `eyJh...`
4. Apri `assistente.html` e sostituisci:
   ```js
   const SB_URL = 'INSERISCI_IL_TUO_SUPABASE_URL';
   const SB_KEY = 'INSERISCI_LA_TUA_SUPABASE_ANON_KEY';
   ```

> ℹ️ La **anon key** è pubblica per design — è sicura nel frontend perché  
> le Row Level Security policies garantiscono che ogni utente veda solo i propri dati.

---

### 2. Cloudflare Worker — proxy API Anthropic

La chiave Anthropic non va **mai** nel frontend. Il Worker fa da proxy sicuro.

1. Vai su [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create Worker**
2. Incolla il contenuto di `cloudflare/worker.js`
3. Clicca **Save and Deploy**
4. Vai su **Settings → Variables and Secrets** → aggiungi:
   - Nome: `ANTHROPIC_API_KEY`
   - Valore: la tua chiave `sk-ant-...` (da [console.anthropic.com](https://console.anthropic.com))
5. Copia il Worker URL (es. `https://ondamente-worker.tuonome.workers.dev`)
6. In `assistente.html` sostituisci:
   ```js
   const API_ENDPOINT = 'INSERISCI_IL_TUO_WORKER_URL/api/chat';
   ```
7. Aggiungi il tuo dominio a `ALLOWED_ORIGINS` nel worker se necessario

---

### 3. GitHub Pages — hosting

1. Crea un repo su GitHub (può essere privato)
2. Carica tutti i file
3. Vai su **Settings → Pages → Source → Deploy from branch → main**
4. Il sito sarà disponibile su `https://tuonome.github.io/ondamente/`

> 💡 Per usare il dominio `ondamente.it`, aggiungi un file `CNAME` con il contenuto  
> `ondamente.it` e configura i DNS del tuo registrar puntando a GitHub Pages.

---

### 4. DNS per dominio custom (ondamente.it)

Nel pannello del tuo registrar (es. OVH, Aruba, Cloudflare):

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
| `profiles` | Profilo utente (università, corso, anno) |
| `subjects` | Materie/esami con libro PDF e profilo DSA |
| `conversations` | Sessioni di chat per materia |
| `messages` | Messaggi singoli (user / assistant) |

Tutte le tabelle hanno **Row Level Security** attiva: ogni utente accede solo ai propri dati.

---

## Variabili da configurare

| File | Variabile | Dove trovarla |
|---|---|---|
| `assistente.html` | `SB_URL` | Supabase → Settings → API → Project URL |
| `assistente.html` | `SB_KEY` | Supabase → Settings → API → anon public key |
| `assistente.html` | `API_ENDPOINT` | URL del tuo Cloudflare Worker + `/api/chat` |
| `cloudflare/worker.js` | `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |

---

## Sviluppo locale

Apri semplicemente `index.html` in un browser, oppure usa Live Server (VS Code).  
Assicurati che `http://127.0.0.1:5500` sia in `ALLOWED_ORIGINS` nel worker.

---

## Licenza

© 2025 OndaMente · Made in Italy 🇮🇹
