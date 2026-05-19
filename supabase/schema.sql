-- ═══════════════════════════════════════════════════════════════
--  OndaMente DSA — Schema Supabase
--  Esegui questo script nel SQL Editor del tuo progetto Supabase
--  Settings → SQL Editor → New query → incolla → Run
-- ═══════════════════════════════════════════════════════════════

-- ── ABILITA ESTENSIONI ──────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── TABELLA: profiles ──────────────────────────────────────────
-- Un record per utente, aggiornato all'onboarding step 1
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  uni         text,
  corso       text,
  anno        text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── TABELLA: subjects ──────────────────────────────────────────
-- Una riga per ogni materia/esame aggiunto dall'utente
create table if not exists public.subjects (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  materia     text not null,
  stile       text,
  esame       text,
  dsa_profile text,         -- es. "Dislessia, ADHD"
  dsa_tools   text,         -- es. "sintesi_vocale,mappe_mentali"
  book_name   text,
  book_text   text,         -- testo estratto dal PDF (può essere lungo)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── TABELLA: conversations ─────────────────────────────────────
-- Ogni sessione di chat è una conversazione legata a una materia
create table if not exists public.conversations (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  subject_id  uuid references public.subjects(id) on delete cascade not null,
  title       text default 'Nuova chat',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── TABELLA: messages ──────────────────────────────────────────
-- Ogni singolo messaggio (user o assistant)
create table if not exists public.messages (
  id               uuid primary key default uuid_generate_v4(),
  conversation_id  uuid references public.conversations(id) on delete cascade not null,
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  created_at       timestamptz default now()
);

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────
-- Ogni utente vede e modifica SOLO i propri dati

alter table public.profiles      enable row level security;
alter table public.subjects      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- profiles
create policy "Utente vede il proprio profilo"
  on public.profiles for select using (auth.uid() = id);
create policy "Utente crea il proprio profilo"
  on public.profiles for insert with check (auth.uid() = id);
create policy "Utente aggiorna il proprio profilo"
  on public.profiles for update using (auth.uid() = id);

-- subjects
create policy "Utente vede le proprie materie"
  on public.subjects for select using (auth.uid() = user_id);
create policy "Utente crea le proprie materie"
  on public.subjects for insert with check (auth.uid() = user_id);
create policy "Utente aggiorna le proprie materie"
  on public.subjects for update using (auth.uid() = user_id);
create policy "Utente elimina le proprie materie"
  on public.subjects for delete using (auth.uid() = user_id);

-- conversations
create policy "Utente vede le proprie conversazioni"
  on public.conversations for select using (auth.uid() = user_id);
create policy "Utente crea le proprie conversazioni"
  on public.conversations for insert with check (auth.uid() = user_id);
create policy "Utente aggiorna le proprie conversazioni"
  on public.conversations for update using (auth.uid() = user_id);
create policy "Utente elimina le proprie conversazioni"
  on public.conversations for delete using (auth.uid() = user_id);

-- messages (accessibili tramite conversation_id, non hanno user_id diretto)
create policy "Utente vede i propri messaggi"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );
create policy "Utente inserisce i propri messaggi"
  on public.messages for insert
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- ── INDICI per performance ──────────────────────────────────────
create index if not exists idx_subjects_user_id
  on public.subjects(user_id);
create index if not exists idx_conversations_subject_id
  on public.conversations(subject_id);
create index if not exists idx_conversations_user_id
  on public.conversations(user_id);
create index if not exists idx_messages_conversation_id
  on public.messages(conversation_id);

-- ── TRIGGER: updated_at automatico ─────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger trg_subjects_updated_at
  before update on public.subjects
  for each row execute function public.set_updated_at();

create trigger trg_conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();
