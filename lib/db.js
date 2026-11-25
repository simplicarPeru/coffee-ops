// Capa de datos: PostgreSQL (Supabase en producción, cualquier Postgres en local).
// loadContext() devuelve la misma forma de datos que usa la lógica de negocio.
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' (sin zona horaria)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX || 3), // pocas conexiones por función serverless
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

const query = async (text, params = []) => (await pool.query(text, params)).rows;
const first = async (text, params = []) => (await query(text, params))[0] || null;
const iso = (v) => (v instanceof Date ? v.toISOString() : v);

// ---------- Mapeos fila -> objeto ----------
const mapUser = (r) => ({
  id: r.id,
  name: r.name,
  username: r.username,
  role: r.role,
  active: r.active,
  pinSalt: r.pin_salt,
  pinHash: r.pin_hash,
});

const mapStore = (r) => ({
  id: r.id,
  name: r.name,
  openBy: r.open_by,
  lat: r.lat,
  lng: r.lng,
  radius: r.radius,
  leaderId: r.leader_id,
  baristaIds: r.barista_ids || [],
});

const mapEvent = (r) => ({
  id: r.id,
  at: iso(r.at),
  type: r.type,
  date: r.day,
  storeId: r.store_id,
  moment: r.moment,
  userId: r.user_id,
  userName: r.user_name,
  detail: r.detail || {},
});

// ---------- Contexto de lectura ----------
// Carga usuarios, tiendas y, para el rango de fechas, registros, aprobaciones y eventos.
export async function loadContext({ from, to }) {
  const [users, stores, checks, approvals, events] = await Promise.all([
    query('select * from users'),
    query('select * from stores order by name'),
    query('select * from checks where day between $1 and $2', [from, to]),
    query('select * from approvals where day between $1 and $2', [from, to]),
    query('select * from events where day between $1 and $2 order by seq', [from, to]),
  ]);

  const checksMap = {};
  for (const r of checks) {
    checksMap[`${r.day}|${r.store_id}|${r.moment}`] = { items: r.items || {}, photos: r.photos || [] };
  }
  const approvalsMap = {};
  for (const r of approvals) {
    approvalsMap[`${r.day}|${r.store_id}`] = {
      status: r.status,
      by: r.by_user_id,
      byName: r.by_name,
      role: r.by_role,
      at: iso(r.at),
      note: r.note,
    };
  }

  return {
    users: users.map(mapUser),
    stores: stores.map(mapStore),
    checks: checksMap,
    approvals: approvalsMap,
    events: events.map(mapEvent),
  };
}

// ---------- Sesiones ----------
export async function getSessionUser(token) {
  const r = await first(
    `select u.* from sessions s join users u on u.id = s.user_id
     where s.token = $1 and u.active = true`,
    [token],
  );
  return r ? mapUser(r) : null;
}

export async function createSession(token, userId) {
  await query('insert into sessions (token, user_id) values ($1, $2)', [token, userId]);
}

export async function deleteSession(token) {
  await query('delete from sessions where token = $1', [token]);
}

export async function deleteSessionsForUser(userId) {
  await query('delete from sessions where user_id = $1', [userId]);
}

// ---------- Usuarios ----------
export async function insertUser(u) {
  await query(
    `insert into users (id, name, username, role, active, pin_salt, pin_hash)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [u.id, u.name, u.username, u.role, u.active, u.pinSalt, u.pinHash],
  );
}

const USER_COLUMNS = { name: 'name', role: 'role', active: 'active', pinSalt: 'pin_salt', pinHash: 'pin_hash' };

export async function updateUser(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(USER_COLUMNS)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return;
  params.push(id);
  await query(`update users set ${sets.join(', ')} where id = $${params.length}`, params);
}

// ---------- Tiendas ----------
export async function insertStore(s) {
  await query(
    `insert into stores (id, name, open_by, lat, lng, radius, leader_id, barista_ids)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do nothing`,
    [s.id, s.name, s.openBy, s.lat, s.lng, s.radius, s.leaderId, s.baristaIds],
  );
}

export async function updateStore(id, s) {
  await query(
    `update stores set name = $2, open_by = $3, lat = $4, lng = $5, radius = $6,
       leader_id = $7, barista_ids = $8 where id = $1`,
    [id, s.name, s.openBy, s.lat, s.lng, s.radius, s.leaderId, s.baristaIds],
  );
}

export async function countRows(table) {
  const r = await first(`select count(*)::int as n from ${table}`);
  return r.n;
}

// ---------- Registros del día (escritura) ----------
export async function getCheckRow(day, storeId, moment) {
  const r = await first('select items, photos from checks where day = $1 and store_id = $2 and moment = $3', [day, storeId, moment]);
  return r ? { items: r.items || {}, photos: r.photos || [] } : { items: {}, photos: [] };
}

export async function saveCheck(day, storeId, moment, check) {
  await query(
    `insert into checks (day, store_id, moment, items, photos)
     values ($1, $2, $3, $4::jsonb, $5::jsonb)
     on conflict (day, store_id, moment) do update set items = excluded.items, photos = excluded.photos`,
    [day, storeId, moment, JSON.stringify(check.items), JSON.stringify(check.photos)],
  );
}

// ---------- Aprobaciones ----------
export async function getApproval(day, storeId) {
  const r = await first('select * from approvals where day = $1 and store_id = $2', [day, storeId]);
  return r ? { status: r.status, by: r.by_user_id, byName: r.by_name, role: r.by_role, at: iso(r.at), note: r.note } : null;
}

export async function saveApproval(day, storeId, a) {
  await query(
    `insert into approvals (day, store_id, status, by_user_id, by_name, by_role, note, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (day, store_id) do update set status = excluded.status, by_user_id = excluded.by_user_id,
       by_name = excluded.by_name, by_role = excluded.by_role, note = excluded.note, at = excluded.at`,
    [day, storeId, a.status, a.by, a.byName, a.role, a.note, a.at],
  );
}

export async function deleteApproval(day, storeId) {
  await query('delete from approvals where day = $1 and store_id = $2', [day, storeId]);
}

// ---------- Eventos ----------
export async function insertEvents(list) {
  for (const e of list) {
    await query(
      `insert into events (id, at, type, day, store_id, moment, user_id, user_name, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        crypto.randomUUID(),
        new Date().toISOString(),
        e.type,
        e.date ?? null,
        e.storeId ?? null,
        e.moment ?? null,
        e.userId ?? null,
        e.userName ?? null,
        JSON.stringify(e.detail || {}),
      ],
    );
  }
}

export async function listStoreEvents(storeId, limit = 300) {
  const rows = await query('select * from events where store_id = $1 order by seq desc limit $2', [storeId, limit]);
  return rows.map(mapEvent);
}
