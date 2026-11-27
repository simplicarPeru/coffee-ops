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

-- ---------- Comercial ----------
-- Rol comercial (CRM, pedidos B2B y resumen). Se puede ejecutar varias veces.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('admin', 'administrativo', 'comercial', 'leader', 'barista'));

create table if not exists crm_contacts (
  id text primary key,
  name text not null,
  company text not null default '',
  role_title text not null default '',
  phone text not null default '',
  email text not null default '',
  source text not null default '',          -- evento, referido, web, otro
  tags text[] not null default '{}',
  notes text not null default '',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_opportunities (
  id text primary key,
  title text not null,
  contact_id text references crm_contacts(id) on delete set null,
  event_name text not null default '',
  event_date date,
  stage text not null default 'lead'
    check (stage in ('lead', 'contactado', 'propuesta', 'negociacion', 'ganado', 'perdido')),
  estimated_value numeric(12, 2) not null default 0,
  probability integer not null default 20 check (probability between 0 and 100),
  expected_close date,
  next_action text not null default '',
  next_action_date date,
  notes text not null default '',
  owner_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists b2b_orders (
  id text primary key,
  customer text not null,
  contact_name text not null default '',
  phone text not null default '',
  address text not null default '',
  items jsonb not null default '[]'::jsonb,   -- [{product, qty, unit_price}]
  total numeric(12, 2) not null default 0,
  status text not null default 'pendiente'
    check (status in ('pendiente', 'preparando', 'en_ruta', 'entregado', 'cancelado')),
  delivery_date date,
  delivery_window text not null default '',
  assigned_to text,
  notes text not null default '',
  proof jsonb,                                  -- {file, at, by}: foto de entrega
  delivered_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table crm_contacts enable row level security;
alter table crm_opportunities enable row level security;
alter table b2b_orders enable row level security;
