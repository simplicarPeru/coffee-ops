-- Operación de tiendas: esquema de base de datos (PostgreSQL / Supabase)
-- Se puede ejecutar varias veces sin romper nada.

create table if not exists users (
  id text primary key,
  name text not null,
  username text not null unique,
  role text not null check (role in ('admin', 'administrativo', 'leader', 'barista')),
  active boolean not null default true,
  pin_salt text not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists stores (
  id text primary key,
  name text not null,
  open_by text not null,                 -- hora de apertura 'HH:MM' (hora de Lima)
  lat double precision,
  lng double precision,
  radius integer not null default 150,   -- metros
  leader_id text references users(id) on delete set null,
  barista_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists checks (
  day date not null,
  store_id text not null references stores(id) on delete cascade,
  moment text not null check (moment in ('opening', 'midday', 'closing')),
  items jsonb not null default '{}'::jsonb,
  photos jsonb not null default '[]'::jsonb,
  primary key (day, store_id, moment)
);

create table if not exists approvals (
  day date not null,
  store_id text not null references stores(id) on delete cascade,
  status text not null check (status in ('approved', 'rejected')),
  by_user_id text,
  by_name text not null,
  by_role text not null,
  note text not null default '',
  at timestamptz not null default now(),
  primary key (day, store_id)
);

-- Bitácora de eventos: de aquí salen las horas de apertura, presencia y reportes.
create table if not exists events (
  seq bigint generated always as identity primary key,
  id text not null unique,
  at timestamptz not null default now(),
  type text not null,
  day date,
  store_id text,
  moment text,
  user_id text,
  user_name text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists events_day_idx on events (day);
create index if not exists events_store_idx on events (store_id, seq desc);

-- Acceso solo desde el servidor (con la cadena de conexión de la base).
-- Activar RLS sin políticas bloquea cualquier acceso directo con la clave pública (anon).
alter table users enable row level security;
alter table stores enable row level security;
alter table sessions enable row level security;
alter table checks enable row level security;
alter table approvals enable row level security;
alter table events enable row level security;
