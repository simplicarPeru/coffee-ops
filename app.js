import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORES as SEED_STORES, MOMENTS, MOMENT_ORDER, TIMEZONE } from './config.js';
import {
  loadContext, getSessionUser, createSession, deleteSession, deleteSessionsForUser,
  insertUser, updateUser, insertStore, updateStore, countRows,
  getCheckRow, saveCheck, getApproval, saveApproval, deleteApproval,
  insertEvents, listStoreEvents,
} from './lib/db.js';
import { uploadPhoto, removePhoto, signUrls, LOCAL_UPLOADS_DIR, storageMode } from './lib/storage.js';
import {
  listContacts, insertContact, updateContact,
  listOpportunities, insertOpportunity, updateOpportunity, getOpportunity,
  listOrders, getOrder, insertOrder, updateOrder,
} from './lib/comercial.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const DEFAULT_RADIUS = 150; // metros

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PIN_RE = /^\d{4,6}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i;
// admin: administración del sistema. administrativo: rol que aprueba aperturas (cualquier persona con ese rol).
const ROLES = ['admin', 'administrativo', 'comercial', 'leader', 'barista'];
const ROLE_LABEL = { admin: 'Administrador', administrativo: 'Administrativo', comercial: 'Comercial', leader: 'Líder', barista: 'Barista' };
const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
const STATUS_LABEL = {
  approved: 'Aprobada',
  awaiting: 'Por aprobar',
  rejected: 'Rechazada',
  in_progress: 'En curso',
  late: 'Atrasada',
  not_opened: 'No abierta',
  pending: 'Pendiente',
};

// ---------- Utilidades ----------
const uid = () => crypto.randomUUID();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

// Hora y fecha en la zona de la operación
function lima(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}:${parts.minute}` };
}

const hhmmOf = (iso) => lima(new Date(iso)).hhmm;

// Distancia en metros (Haversine)
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// PIN con scrypt
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { pinSalt: salt, pinHash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}

function verifyPin(user, pin) {
  if (!user.pinSalt || !user.pinHash) return false;
  const { pinHash } = hashPin(pin, user.pinSalt);
  return crypto.timingSafeEqual(Buffer.from(pinHash, 'hex'), Buffer.from(user.pinHash, 'hex'));
}

// ---------- Arranque: tiendas semilla y admin inicial (una sola vez por instancia) ----------
let bootPromise = null;
function ensureBootstrap() {
  if (!bootPromise) {
    bootPromise = (async () => {
      if ((await countRows('stores')) === 0) {
        for (const s of SEED_STORES) {
          await insertStore({
            id: s.id,
            name: s.name,
            openBy: MOMENTS.opening.deadline,
            lat: null,
            lng: null,
            radius: DEFAULT_RADIUS,
            leaderId: null,
            baristaIds: [],
          });
        }
      }
      if ((await countRows('users')) === 0) {
        await insertUser({ id: uid(), name: 'Administrador', username: ADMIN_USER, role: 'admin', active: true, ...hashPin(ADMIN_PIN) });
        console.warn(`Usuario admin creado: "${ADMIN_USER}". Cambia el PIN con ADMIN_PIN antes de usarlo.`);
      }
    })().catch((err) => {
      bootPromise = null; // reintentar en la siguiente petición
      throw err;
    });
  }
  return bootPromise;
}

// ---------- Helpers de dominio (funciones puras sobre el contexto cargado) ----------
const pub = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active });

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function validDate(value, fallback) {
  return DATE_RE.test(value || '') ? value : fallback;
}

function membersOf(ctx, store) {
  return [store.leaderId, ...store.baristaIds]
    .filter(Boolean)
    .map((id) => ctx.users.find((u) => u.id === id))
    .filter((u) => u && u.active);
}

function storeOfUser(ctx, userId) {
  return ctx.stores.find((s) => s.leaderId === userId || s.baristaIds.includes(userId));
}

function canAccessStore(ctx, user, storeId) {
  if (user.role === 'admin' || user.role === 'administrativo') return true;
  const store = ctx.stores.find((s) => s.id === storeId);
  return !!store && (store.leaderId === user.id || store.baristaIds.includes(user.id));
}

function getCheck(ctx, date, storeId, m) {
  return ctx.checks[`${date}|${storeId}|${m}`] || { items: {}, photos: [] };
}

function isItemDone(check, item) {
  if (item.type === 'check') return !!check.items?.[item.id]?.done;
  return (check.photos || []).some((p) => p.itemId === item.id);
}

function momentComplete(check, m) {
  return MOMENTS[m].items.every((i) => isItemDone(check, i));
}

function deadlineFor(store, m) {
  return m === 'opening' ? store.openBy : MOMENTS[m].deadline;
}

function momentSummary(check, m, deadline, date, today, hhmm) {
  const moment = MOMENTS[m];
  const total = moment.items.length;
  const done = moment.items.filter((i) => isItemDone(check, i)).length;

  let state;
  if (done === total) state = 'complete';
  else if (date < today) state = 'incomplete';
  else if (date === today && hhmm > deadline) state = 'late';
  else if (done > 0) state = 'in_progress';
  else state = 'pending';

  const times = [...Object.values(check.items || {}).map((x) => x.at), ...(check.photos || []).map((p) => p.at)]
    .filter(Boolean)
    .sort();

  return {
    label: moment.label,
    state,
    done,
    total,
    lastAt: times.at(-1) || null,
    deadline,
    pending: moment.items.filter((i) => !isItemDone(check, i)).map((i) => i.label),
  };
}

function itemsView(check, m) {
  return MOMENTS[m].items.map((item) => ({
    id: item.id,
    label: item.label,
    type: item.type,
    done: isItemDone(check, item),
    by: check.items?.[item.id]?.by || null,
    at: check.items?.[item.id]?.at || null,
    note: check.items?.[item.id]?.note || '',
    photos: (check.photos || []).filter((p) => p.itemId === item.id),
  }));
}

// Índices de eventos para consultas rápidas
function buildIndex(events) {
  const idx = { completed: new Map(), firstIn: new Map(), lastPresence: new Map() };
  for (const e of events) {
    const momentKey = `${e.date}|${e.storeId}|${e.moment}`;
    if (e.type === 'moment.completed') idx.completed.set(momentKey, e.at);
    else if (e.type === 'moment.reopened') idx.completed.delete(momentKey);
    else if (e.type === 'presence.in' || e.type === 'presence.out') {
      const k = `${e.date}|${e.storeId}|${e.userId}`;
      const entry = {
        type: e.type === 'presence.in' ? 'in' : 'out',
        at: e.at,
        method: e.detail?.method || null,
        distance: e.detail?.distance ?? null,
        photoPath: e.detail?.photoPath || null,
      };
      idx.lastPresence.set(k, entry);
      if (entry.type === 'in' && !idx.firstIn.has(k)) idx.firstIn.set(k, entry);
    }
  }
  return idx;
}

// Estado de la apertura: completa = lista para aprobar; aprobada = abierta OK
function openingState(ctx, store, date, sumOpening) {
  const approval = ctx.approvals[`${date}|${store.id}`] || null;
  let status;
  if (approval?.status === 'approved') status = 'approved';
  else if (approval?.status === 'rejected') status = 'rejected';
  else if (sumOpening.state === 'complete') status = 'awaiting';
  else if (sumOpening.state === 'incomplete') status = 'not_opened';
  else status = sumOpening.state; // in_progress | late | pending
  return { status, approval };
}

function storeDayView(ctx, idx, store, date, today, hhmm) {
  const moments = {};
  for (const m of MOMENT_ORDER) {
    moments[m] = momentSummary(getCheck(ctx, date, store.id, m), m, deadlineFor(store, m), date, today, hhmm);
  }
  const { status, approval } = openingState(ctx, store, date, moments.opening);
  const openedIso = idx.completed.get(`${date}|${store.id}|opening`) || null;
  const openedAt = openedIso ? hhmmOf(openedIso) : null;

  const members = membersOf(ctx, store).map((u) => {
    const last = idx.lastPresence.get(`${date}|${store.id}|${u.id}`);
    const present = last?.type === 'in';
    return {
      id: u.id,
      name: u.name,
      role: u.id === store.leaderId ? 'leader' : 'barista',
      present,
      since: present ? hhmmOf(last.at) : null,
      method: present ? last.method : null,
      photoPath: present ? last.photoPath : null,
    };
  });

  return {
    id: store.id,
    name: store.name,
    openBy: store.openBy,
    leader: ctx.users.find((u) => u.id === store.leaderId)?.name || null,
    baristas: store.baristaIds.map((id) => ctx.users.find((u) => u.id === id)?.name).filter(Boolean),
    status,
    statusLabel: STATUS_LABEL[status],
    approval: approval
      ? { status: approval.status, byName: approval.byName, at: approval.at, note: approval.note || '' }
      : null,
    openedAt,
    onTime: openedAt ? openedAt <= store.openBy : null,
    moments,
    presence: {
      total: members.length,
      present: members.filter((m) => m.present).length,
      members,
    },
  };
}

// Convierte rutas de fotos en URLs (firmadas en producción) sin tocar el resto de la respuesta
async function attachPhotoUrls(payload) {
  const paths = new Set();
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(visit);
    if (typeof o.file === 'string') paths.add(o.file);
    if (typeof o.photoPath === 'string') paths.add(o.photoPath);
    Object.values(o).forEach(visit);
  };
  visit(payload);
  const urls = await signUrls([...paths]);
  const apply = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(apply);
    if (typeof o.file === 'string') o.url = urls.get(o.file) || null;
    if ('photoPath' in o) o.photoUrl = typeof o.photoPath === 'string' ? urls.get(o.photoPath) || null : null;
    Object.values(o).forEach(apply);
  };
  apply(payload);
  return payload;
}

// Aplica un cambio en un momento del día, guarda el registro y emite eventos
async function applyChange(actor, { date, storeId, m, type, detail, mutate }) {
  const check = await getCheckRow(date, storeId, m);
  const before = momentComplete(check, m);
  const result = mutate(check);
  await saveCheck(date, storeId, m, check);

  const base = { date, storeId, moment: m, userId: actor.id, userName: actor.name };
  const events = [{ ...base, type, detail }];
  const after = momentComplete(check, m);
  if (!before && after) events.push({ ...base, type: 'moment.completed' });
  if (before && !after) events.push({ ...base, type: 'moment.reopened' });

  // Cualquier cambio en la apertura invalida la aprobación anterior
  if (m === 'opening' && (await getApproval(date, storeId))) {
    await deleteApproval(date, storeId);
    events.push({ ...base, type: 'approval.invalidated' });
  }
  await insertEvents(events);
  return result;
}

function validateStoreInput(ctx, body, selfId) {
  const name = cleanText(body.name, 60);
  if (name.length < 2) return { error: 'El nombre de la tienda es obligatorio' };
  const openBy = String(body.openBy || '');
  if (!TIME_RE.test(openBy)) return { error: 'La hora de apertura debe ser HH:MM' };

  // Ubicación: opcional, pero si se pone, deben ser ambas coordenadas válidas
  const latRaw = body.lat ?? null;
  const lngRaw = body.lng ?? null;
  const hasLat = latRaw !== null && latRaw !== '';
  const hasLng = lngRaw !== null && lngRaw !== '';
  if (hasLat !== hasLng) return { error: 'Pon latitud y longitud, o deja ambas vacías' };
  const lat = hasLat ? Number(latRaw) : null;
  const lng = hasLng ? Number(lngRaw) : null;
  if (hasLat && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return { error: 'Latitud no válida' };
  if (hasLng && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return { error: 'Longitud no válida' };
  const radius = Number(body.radius ?? DEFAULT_RADIUS);
  if (!Number.isFinite(radius) || radius < 30 || radius > 1000) return { error: 'El radio debe estar entre 30 y 1000 metros' };

  const leaderId = body.leaderId || null;
  const baristaIds = Array.isArray(body.baristaIds) ? [...new Set(body.baristaIds.filter(Boolean))] : [];
  const assigned = new Set();
  if (leaderId) {
    const leader = ctx.users.find((u) => u.id === leaderId && u.active);
    if (!leader) return { error: 'El líder no existe o está inactivo' };
    assigned.add(leaderId);
  }
  for (const id of baristaIds) {
    if (assigned.has(id)) return { error: 'Una persona no puede ser líder y barista a la vez' };
    const user = ctx.users.find((u) => u.id === id && u.active);
    if (!user) return { error: 'Algún barista no existe o está inactivo' };
    assigned.add(id);
  }
  for (const other of ctx.stores) {
    if (other.id === selfId) continue;
    const taken = [other.leaderId, ...other.baristaIds];
    if ([...assigned].some((id) => taken.includes(id))) {
      return { error: `Alguna persona ya está asignada a ${other.name}` };
    }
  }
  return { data: { name, openBy, lat, lng, radius, leaderId, baristaIds } };
}

function storeOut(ctx, s) {
  return {
    id: s.id,
    name: s.name,
    openBy: s.openBy,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    radius: s.radius ?? DEFAULT_RADIUS,
    leaderId: s.leaderId,
    leader: ctx.users.find((u) => u.id === s.leaderId)?.name || null,
    baristaIds: s.baristaIds,
    baristas: s.baristaIds.map((id) => ctx.users.find((u) => u.id === id)).filter(Boolean).map((u) => ({ id: u.id, name: u.name })),
  };
}

function userOut(ctx, u) {
  const store = storeOfUser(ctx, u.id);
  return { ...pub(u), storeId: store?.id || null, storeName: store?.name || null };
}

// ---------- Middlewares ----------
const auth = wrap(async (req, res, next) => {
  const token = bearer(req);
  const user = token ? await getSessionUser(token) : null;
  if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar' });
  req.user = pub(user);
  req.token = token;
  next();
});

const requireRoles = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'No tienes permiso para esto' });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME[file.mimetype] !== undefined),
});

// Ruta relativa de la foto en el almacenamiento: fecha/tienda/archivo
function newPhotoPath(date, storeId, mimetype, prefix = '') {
  const id = uid();
  return { id, relPath: `${date}/${storeId}/${prefix}${id}${ALLOWED_MIME[mimetype]}` };
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(wrap(async (req, res, next) => {
  await ensureBootstrap();
  next();
}));

// Páginas (en Vercel las sirve el CDN desde public/; aquí quedan como respaldo para local)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/tienda', (req, res) => res.sendFile(path.join(__dirname, 'public', 'store.html')));
app.get('/comercial', (req, res) => res.sendFile(path.join(__dirname, 'public', 'comercial.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
if (storageMode === 'local') app.use('/uploads', express.static(LOCAL_UPLOADS_DIR));

app.get('/api/config', (req, res) => {
  res.json({
    moments: MOMENTS,
    momentOrder: MOMENT_ORDER,
    timezone: TIMEZONE,
    statusLabel: STATUS_LABEL,
    roleLabel: ROLE_LABEL,
  });
});

// ---------- Sesión ----------
app.post('/api/login', wrap(async (req, res) => {
  const username = cleanText(req.body.username, 60).toLowerCase();
  const pin = String(req.body.pin ?? '');
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  const user = ctx.users.find((u) => u.username.toLowerCase() === username && u.active);
  if (!user || !verifyPin(user, pin)) return res.status(401).json({ error: 'Usuario o PIN incorrecto' });

  const token = crypto.randomBytes(32).toString('hex');
  await createSession(token, user.id);
  res.json({ token, user: pub(user) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = bearer(req);
  if (token) await deleteSession(token);
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  const store = storeOfUser(ctx, req.user.id);
  res.json({
    user: req.user,
    store: store ? { id: store.id, name: store.name, openBy: store.openBy } : null,
  });
}));

// ---------- Usuarios (admin) ----------
app.get('/api/users', auth, requireRoles('admin'), wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  res.json({ users: ctx.users.map((u) => userOut(ctx, u)) });
}));

app.post('/api/users', auth, requireRoles('admin'), wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  const name = cleanText(req.body.name, 60);
  const username = cleanText(req.body.username, 30).toLowerCase();
  const role = req.body.role;
  const pin = String(req.body.pin ?? '');
  if (name.length < 2) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Usuario: 3–30 letras, números, punto, guion o guion bajo' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol no válido' });
  if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'El PIN debe tener de 4 a 6 números' });
  if (ctx.users.some((u) => u.username.toLowerCase() === username)) return res.status(409).json({ error: 'Ese usuario ya existe' });

  const user = { id: uid(), name, username, role, active: true, ...hashPin(pin) };
  await insertUser(user);
  await insertEvents([{ type: 'user.created', userId: req.user.id, userName: req.user.name, detail: { name, role, createdUserId: user.id } }]);
  res.status(201).json({ user: { ...pub(user), storeId: null, storeName: null } });
}));

app.patch('/api/users/:id', auth, requireRoles('admin'), wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  const user = ctx.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const b = req.body;
  const patch = {};

  if (b.name !== undefined) {
    const name = cleanText(b.name, 60);
    if (name.length < 2) return res.status(400).json({ error: 'El nombre es obligatorio' });
    patch.name = name;
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Rol no válido' });
    patch.role = b.role;
  }
  if (b.pin) {
    const pin = String(b.pin);
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'El PIN debe tener de 4 a 6 números' });
    Object.assign(patch, hashPin(pin));
    await deleteSessionsForUser(user.id);
  }
  if (b.active !== undefined) {
    if (user.id === req.user.id && !b.active) return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    patch.active = !!b.active;
    if (!patch.active) await deleteSessionsForUser(user.id);
  }
  await updateUser(user.id, patch);

  const fresh = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  res.json({ user: userOut(fresh, fresh.users.find((u) => u.id === user.id)) });
}));

// ---------- Tiendas ----------
app.get('/api/stores', auth, requireRoles('admin', 'administrativo'), wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  res.json({ stores: ctx.stores.map((s) => storeOut(ctx, s)) });
}));

app.post('/api/stores', auth, requireRoles('admin'), wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  const v = validateStoreInput(ctx, req.body, null);
  if (v.error) return res.status(400).json({ error: v.error });
  const store = { id: `tienda-${uid().slice(0, 8)}`, ...v.data };
  await insertStore(store);
  await insertEvents([{ type: 'store.created', storeId: store.id, userId: req.user.id, userName: req.user.name, detail: { name: store.name } }]);
  const fresh = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  res.status(201).json({ store: storeOut(fresh, fresh.stores.find((s) => s.id === store.id)) });
}));

app.patch('/api/stores/:id', auth, requireRoles('admin'), wrap(async (req, res) => {
  const ctx = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  const store = ctx.stores.find((s) => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Tienda no encontrada' });
  const b = req.body;
  const merged = {
    name: b.name ?? store.name,
    openBy: b.openBy ?? store.openBy,
    lat: b.lat !== undefined ? b.lat : store.lat,
    lng: b.lng !== undefined ? b.lng : store.lng,
    radius: b.radius ?? store.radius ?? DEFAULT_RADIUS,
    leaderId: b.leaderId !== undefined ? b.leaderId : store.leaderId,
    baristaIds: b.baristaIds ?? store.baristaIds,
  };
  const v = validateStoreInput(ctx, merged, store.id);
  if (v.error) return res.status(400).json({ error: v.error });
  await updateStore(store.id, v.data);
  await insertEvents([{ type: 'store.updated', storeId: store.id, userId: req.user.id, userName: req.user.name, detail: v.data }]);
  const fresh = await loadContext({ from: '1970-01-01', to: '1970-01-01' });
  res.json({ store: storeOut(fresh, fresh.stores.find((s) => s.id === store.id)) });
}));

// ---------- Vista del día (admin y administrativo) ----------
app.get('/api/overview', auth, requireRoles('admin', 'administrativo'), wrap(async (req, res) => {
  const { today, hhmm } = lima();
  const date = validDate(req.query.date, today);
  const ctx = await loadContext({ from: date, to: date });
  const idx = buildIndex(ctx.events);
  const stores = ctx.stores.map((s) => storeDayView(ctx, idx, s, date, today, hhmm));

  const count = (fn) => stores.filter(fn).length;
  res.json(await attachPhotoUrls({
    date,
    today,
    now: hhmm,
    stores,
    summary: {
      total: stores.length,
      approved: count((s) => s.status === 'approved'),
      awaiting: count((s) => s.status === 'awaiting'),
      rejected: count((s) => s.status === 'rejected'),
      late: count((s) => s.status === 'late'),
      notOpened: count((s) => s.status === 'not_opened'),
      middayDone: count((s) => s.moments.midday.state === 'complete'),
      closingDone: count((s) => s.moments.closing.state === 'complete'),
      presentNow: stores.reduce((n, s) => n + s.presence.present, 0),
      expectedStaff: stores.reduce((n, s) => n + s.presence.total, 0),
    },
  }));
}));

// Detalle de una tienda en un día
app.get('/api/stores/:id/checks', auth, wrap(async (req, res) => {
  const { today, hhmm } = lima();
  const date = validDate(req.query.date, today);
  const ctx = await loadContext({ from: date, to: date });
  const store = ctx.stores.find((s) => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Tienda no encontrada' });
  if (!canAccessStore(ctx, req.user, store.id)) return res.status(403).json({ error: 'Esta tienda no es tuya' });

  const idx = buildIndex(ctx.events);
  const view = storeDayView(ctx, idx, store, date, today, hhmm);
  const moments = {};
  for (const m of MOMENT_ORDER) {
    moments[m] = { ...view.moments[m], items: itemsView(getCheck(ctx, date, store.id, m), m) };
  }
  res.json(await attachPhotoUrls({ ...view, moments, date, today, now: hhmm }));
}));

// Marcar punto de tipo "check"
app.put('/api/stores/:id/items/:moment/:itemId', auth, wrap(async (req, res) => {
  const { id, moment: m, itemId } = req.params;
  const item = MOMENTS[m]?.items.find((i) => i.id === itemId);
  const { today } = lima();
  const date = validDate(req.body.date, today);
  const ctx = await loadContext({ from: date, to: date });
  if (!ctx.stores.some((s) => s.id === id)) return res.status(404).json({ error: 'Tienda no encontrada' });
  if (!canAccessStore(ctx, req.user, id)) return res.status(403).json({ error: 'Esta tienda no es tuya' });
  if (!item) return res.status(404).json({ error: 'Punto no encontrado' });
  if (item.type !== 'check') return res.status(400).json({ error: 'Este punto se completa con foto' });

  const done = !!req.body.done;
  const note = cleanText(req.body.note, 500);
  const actor = req.user;
  await applyChange(actor, {
    date,
    storeId: id,
    m,
    type: 'item.checked',
    detail: { itemId, label: item.label, done, note },
    mutate: (check) => {
      check.items[itemId] = { done, by: actor.name, note, at: new Date().toISOString() };
    },
  });
  res.json({ ok: true });
}));

// Subir foto de un punto
app.post('/api/stores/:id/photos/:moment/:itemId', auth, upload.single('photo'), wrap(async (req, res) => {
  const { id, moment: m, itemId } = req.params;
  const item = MOMENTS[m]?.items.find((i) => i.id === itemId);
  if (!req.file) return res.status(400).json({ error: 'Formato de imagen no válido' });

  const { today } = lima();
  const date = validDate(req.body.date, today);
  const ctx = await loadContext({ from: date, to: date });
  if (!ctx.stores.some((s) => s.id === id) || !item) return res.status(404).json({ error: 'Tienda o punto no encontrado' });
  if (!canAccessStore(ctx, req.user, id)) return res.status(403).json({ error: 'Esta tienda no es tuya' });

  const { id: photoId, relPath } = newPhotoPath(date, id, req.file.mimetype);
  await uploadPhoto(relPath, req.file.buffer, req.file.mimetype);

  const photo = {
    id: photoId,
    itemId,
    file: relPath,
    by: req.user.name,
    caption: cleanText(req.body.caption, 200),
    at: new Date().toISOString(),
  };
  await applyChange(req.user, {
    date,
    storeId: id,
    m,
    type: 'photo.added',
    detail: { itemId, label: item.label, photoId },
    mutate: (check) => check.photos.push(photo),
  });
  res.status(201).json(await attachPhotoUrls({ ok: true, photo: { ...photo } }));
}));

// Eliminar foto de un punto
app.delete('/api/stores/:id/photos/:moment/:photoId', auth, wrap(async (req, res) => {
  const { id, moment: m, photoId } = req.params;
  const date = validDate(req.query.date, lima().today);
  const ctx = await loadContext({ from: date, to: date });
  if (!canAccessStore(ctx, req.user, id)) return res.status(403).json({ error: 'Esta tienda no es tuya' });

  const existing = (await getCheckRow(date, id, m)).photos.find((p) => p.id === photoId);
  if (!existing) return res.status(404).json({ error: 'Foto no encontrada' });

  await applyChange(req.user, {
    date,
    storeId: id,
    m,
    type: 'photo.deleted',
    detail: { photoId, itemId: existing.itemId },
    mutate: (check) => {
      check.photos = check.photos.filter((p) => p.id !== photoId);
    },
  });
  await removePhoto(existing.file);
  res.json({ ok: true });
}));

// Entrada y salida del personal.
// Entrada: se verifica por ubicación (dentro del radio de la tienda). Si no hay ubicación o está fuera,
// se pide una foto de la entrada, que queda como respaldo.
app.post('/api/stores/:id/presence', auth, upload.single('photo'), wrap(async (req, res) => {
  const { today } = lima();
  const ctx = await loadContext({ from: today, to: today });
  const store = ctx.stores.find((s) => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Tienda no encontrada' });
  if (!membersOf(ctx, store).some((u) => u.id === req.user.id)) {
    return res.status(403).json({ error: 'Solo el personal asignado a esta tienda puede marcar entrada' });
  }

  if (req.body.type === 'out') {
    await insertEvents([{ type: 'presence.out', date: today, storeId: store.id, userId: req.user.id, userName: req.user.name }]);
    return res.json({ ok: true });
  }

  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const accuracy = Number(req.body.accuracy);
  const hasGeo = req.body.lat !== undefined && req.body.lat !== '' && Number.isFinite(lat) && Number.isFinite(lng);
  const hasStoreGeo = store.lat != null && store.lng != null;
  const distance = hasGeo && hasStoreGeo ? Math.round(distanceMeters(lat, lng, store.lat, store.lng)) : null;
  const inRange = distance !== null && distance <= (store.radius ?? DEFAULT_RADIUS);

  if (!inRange && !req.file) {
    const error = distance === null
      ? 'No pudimos verificar tu ubicación. Toma una foto de la entrada.'
      : `Estás a ${distance} m de la tienda. Toma una foto de la entrada para registrarla.`;
    return res.status(422).json({ code: 'NEED_PHOTO', error, distance });
  }

  let photoPath = null;
  if (req.file) {
    const p = newPhotoPath(today, store.id, req.file.mimetype, 'entrada-');
    await uploadPhoto(p.relPath, req.file.buffer, req.file.mimetype);
    photoPath = p.relPath;
  }

  const method = inRange ? 'ubicación' : 'foto';
  await insertEvents([{
    type: 'presence.in',
    date: today,
    storeId: store.id,
    userId: req.user.id,
    userName: req.user.name,
    detail: {
      method,
      distance,
      accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
      photoPath,
    },
  }]);
  res.json({ ok: true, method, distance });
}));

// Aprobación de la apertura: solo el rol administrativo
app.post('/api/stores/:id/approval', auth, requireRoles('administrativo'), wrap(async (req, res) => {
  const { today } = lima();
  const date = validDate(req.body.date, today);
  const ctx = await loadContext({ from: date, to: date });
  const store = ctx.stores.find((s) => s.id === req.params.id);
  if (!store) return res.status(404).json({ error: 'Tienda no encontrada' });

  if (!momentComplete(await getCheckRow(date, store.id, 'opening'), 'opening')) {
    return res.status(409).json({ error: 'La apertura aún no está completa' });
  }

  const decision = req.body.decision;
  if (decision !== 'approve' && decision !== 'reject') return res.status(400).json({ error: 'Decisión no válida' });
  const note = cleanText(req.body.note, 500);
  if (decision === 'reject' && !note) return res.status(400).json({ error: 'Explica el motivo del rechazo' });

  const status = decision === 'approve' ? 'approved' : 'rejected';
  await saveApproval(date, store.id, {
    status,
    by: req.user.id,
    byName: req.user.name,
    role: req.user.role,
    at: new Date().toISOString(),
    note,
  });
  await insertEvents([{
    type: status === 'approved' ? 'approval.approved' : 'approval.rejected',
    date,
    storeId: store.id,
    moment: 'opening',
    userId: req.user.id,
    userName: req.user.name,
    detail: { note, role: req.user.role },
  }]);
  res.json({ ok: true, status });
}));

// ---------- Reportes de apertura (basados en eventos) ----------
function openingRows(ctx, idx, today, nowHhmm, month) {
  const [y, mo] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const rows = [];
  for (let d = 1; d <= lastDay; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (date > today) break;
    for (const store of ctx.stores) {
      const moments = { opening: momentSummary(getCheck(ctx, date, store.id, 'opening'), 'opening', store.openBy, date, today, nowHhmm) };
      const { status, approval } = openingState(ctx, store, date, moments.opening);
      const openedIso = idx.completed.get(`${date}|${store.id}|opening`) || null;
      const openedAt = openedIso ? hhmmOf(openedIso) : '';
      const arrivals = membersOf(ctx, store)
        .map((u) => ({ u, e: idx.firstIn.get(`${date}|${store.id}|${u.id}`) }))
        .filter((x) => x.e)
        .sort((a, b) => (a.e.at < b.e.at ? -1 : 1));
      const first = arrivals[0];
      rows.push({
        date,
        storeId: store.id,
        store: store.name,
        openBy: store.openBy,
        openedAt,
        onTime: openedAt ? openedAt <= store.openBy : null,
        statusKey: status,
        status: STATUS_LABEL[status],
        approvedBy: approval?.byName || '',
        approvedRole: approval ? ROLE_LABEL[approval.role] || '' : '',
        approvedAt: approval ? hhmmOf(approval.at) : '',
        firstArrival: first ? hhmmOf(first.e.at) : '',
        firstArrivalBy: first ? first.u.name : '',
        firstArrivalMethod: first ? first.e.method || '' : '',
      });
    }
  }
  return rows;
}

app.get('/api/reports/openings', auth, requireRoles('admin', 'administrativo'), wrap(async (req, res) => {
  const { today, hhmm } = lima();
  const month = MONTH_RE.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const [y, mo] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const ctx = await loadContext({ from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` });
  const idx = buildIndex(ctx.events);
  const rows = openingRows(ctx, idx, today, hhmm, month);

  const perStore = ctx.stores.map((store) => {
    const rs = rows.filter((r) => r.storeId === store.id);
    const opened = rs.filter((r) => r.openedAt);
    const onTime = opened.filter((r) => r.onTime);
    const approved = rs.filter((r) => r.statusKey === 'approved');
    return {
      store: store.name,
      days: rs.length,
      opened: opened.length,
      onTime: onTime.length,
      approved: approved.length,
      pctOnTime: opened.length ? Math.round((onTime.length / opened.length) * 100) : null,
      pctApproved: rs.length ? Math.round((approved.length / rs.length) * 100) : null,
    };
  });

  if (req.query.format === 'csv') {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = [
      'Fecha', 'Tienda', 'Hora de apertura', 'Abrió', 'A tiempo', 'Estado',
      'Aprobada por', 'Rol que aprobó', 'Hora de aprobación',
      'Primera llegada', 'Quién llegó primero', 'Cómo se verificó la llegada',
    ];
    const lines = rows.map((r) => [
      r.date, r.store, r.openBy, r.openedAt,
      r.onTime === null ? '' : r.onTime ? 'Sí' : 'No',
      r.status, r.approvedBy, r.approvedRole, r.approvedAt,
      r.firstArrival, r.firstArrivalBy, r.firstArrivalMethod,
    ].map(esc).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="aperturas-${month}.csv"`);
    return res.send('﻿' + [header.map(esc).join(','), ...lines].join('\n'));
  }

  res.json({ month, rows: rows.map(({ storeId, statusKey, ...r }) => r), perStore });
}));

// Historial de eventos de una tienda (auditoría)
app.get('/api/stores/:id/events', auth, requireRoles('admin', 'administrativo'), wrap(async (req, res) => {
  res.json({ events: await listStoreEvents(req.params.id) });
}));

// ---------- Comercial (CRM, pedidos B2B y resumen) ----------
const COMERCIAL = requireRoles('admin', 'administrativo', 'comercial');
const STAGES = ['lead', 'contactado', 'propuesta', 'negociacion', 'ganado', 'perdido'];
const OPEN_STAGES = ['lead', 'contactado', 'propuesta', 'negociacion'];
const ORDER_STATUSES = ['pendiente', 'preparando', 'en_ruta', 'entregado', 'cancelado'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const optDate = (v) => (v ? (DATE_RE.test(String(v)) ? String(v) : 'bad') : null);
const sum = (list, fn) => list.reduce((n, x) => n + fn(x), 0);

// Acepta líneas como "2 x Café de especialidad 1kg @ 65" y calcula el total en el servidor
function parseOrderItems(raw) {
  const lines = Array.isArray(raw) ? raw : String(raw || '').split('\n');
  const items = [];
  for (const line of lines) {
    if (typeof line === 'object' && line) {
      const qty = Number(line.qty);
      const unitPrice = Number(line.unitPrice ?? line.unit_price);
      const product = cleanText(line.product, 120);
      if (!product || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(unitPrice) || unitPrice < 0) return { error: 'Revisa los productos del pedido' };
      items.push({ product, qty, unitPrice });
      continue;
    }
    const text = String(line).trim();
    if (!text) continue;
    const m = text.match(/^(\d+)\s*x\s*(.+?)\s*@\s*(\d+(?:[.,]\d+)?)$/i);
    if (!m) return { error: `Línea no válida: "${text}". Usa el formato: 2 x Producto @ 65` };
    items.push({ product: cleanText(m[2], 120), qty: Number(m[1]), unitPrice: Number(m[3].replace(',', '.')) });
  }
  if (!items.length) return { error: 'El pedido necesita al menos un producto' };
  const total = Math.round(sum(items, (i) => i.qty * i.unitPrice) * 100) / 100;
  return { items, total };
}

app.get('/api/comercial/summary', auth, COMERCIAL, wrap(async (req, res) => {
  const { today } = lima();
  const month = today.slice(0, 7);
  const [opps, orders, contacts] = await Promise.all([listOpportunities(), listOrders(), listContacts()]);
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const oppView = (o) => ({ id: o.id, title: o.title, contact: contactName.get(o.contactId) || '', stage: o.stage, nextAction: o.nextAction, nextActionDate: o.nextActionDate, estimatedValue: o.estimatedValue, probability: o.probability });

  const open = opps.filter((o) => OPEN_STAGES.includes(o.stage));
  const weighted = (list) => sum(list, (o) => (o.estimatedValue * o.probability) / 100);
  const closeThisMonth = open.filter((o) => o.expectedClose && o.expectedClose.startsWith(month));
  const won = opps.filter((o) => o.stage === 'ganado' && o.updatedAt.slice(0, 7) === month);

  const openOrders = orders.filter((o) => !['entregado', 'cancelado'].includes(o.status));
  const delivered = orders.filter((o) => o.status === 'entregado' && (o.deliveredAt || '').slice(0, 7) === month);
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, orders.filter((o) => o.status === s).length]));

  res.json(await attachPhotoUrls({
    today,
    month,
    pipeline: {
      openCount: open.length,
      openValue: sum(open, (o) => o.estimatedValue),
      weightedValue: weighted(open),
      closeThisMonth: { count: closeThisMonth.length, value: sum(closeThisMonth, (o) => o.estimatedValue), weighted: weighted(closeThisMonth) },
      wonThisMonth: { count: won.length, value: sum(won, (o) => o.estimatedValue) },
      lostCount: opps.filter((o) => o.stage === 'perdido').length,
    },
    byStage: STAGES.map((stage) => {
      const list = opps.filter((o) => o.stage === stage);
      return { stage, count: list.length, value: sum(list, (o) => o.estimatedValue) };
    }),
    crm: {
      contacts: contacts.length,
      newContactsThisMonth: contacts.filter((c) => c.createdAt.slice(0, 7) === month).length,
      overdue: open.filter((o) => o.nextActionDate && o.nextActionDate < today).map(oppView),
      dueToday: open.filter((o) => o.nextActionDate === today).map(oppView),
    },
    orders: {
      openCount: openOrders.length,
      byStatus,
      today: orders.filter((o) => o.deliveryDate === today && o.status !== 'cancelado'),
      late: openOrders.filter((o) => o.deliveryDate && o.deliveryDate < today),
      deliveredThisMonth: { count: delivered.length, value: sum(delivered, (o) => o.total) },
    },
  }));
}));

// CRM: contactos
app.get('/api/comercial/contacts', auth, COMERCIAL, wrap(async (req, res) => {
  res.json({ contacts: await listContacts() });
}));

function contactFields(b, existing = {}) {
  const name = b.name !== undefined ? cleanText(b.name, 80) : existing.name;
  if (!name || name.length < 2) return { error: 'El nombre del contacto es obligatorio' };
  const email = b.email !== undefined ? cleanText(b.email, 120) : existing.email || '';
  if (email && !EMAIL_RE.test(email)) return { error: 'Correo no válido' };
  const tags = b.tags !== undefined
    ? (Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t) => cleanText(t, 30)).filter(Boolean).slice(0, 10)
    : existing.tags || [];
  return {
    data: {
      name,
      company: b.company !== undefined ? cleanText(b.company, 120) : existing.company || '',
      roleTitle: b.roleTitle !== undefined ? cleanText(b.roleTitle, 80) : existing.roleTitle || '',
      phone: b.phone !== undefined ? cleanText(b.phone, 30) : existing.phone || '',
      email,
      source: b.source !== undefined ? cleanText(b.source, 40) : existing.source || '',
      tags,
      notes: b.notes !== undefined ? cleanText(b.notes, 2000) : existing.notes || '',
    },
  };
}

app.post('/api/comercial/contacts', auth, COMERCIAL, wrap(async (req, res) => {
  const v = contactFields(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const contact = { id: uid(), ...v.data, createdBy: req.user.id };
  await insertContact(contact);
  await insertEvents([{ type: 'comercial.contact.created', userId: req.user.id, userName: req.user.name, detail: { id: contact.id, name: contact.name } }]);
  res.status(201).json({ ok: true, id: contact.id });
}));

app.patch('/api/comercial/contacts/:id', auth, COMERCIAL, wrap(async (req, res) => {
  const current = (await listContacts()).find((c) => c.id === req.params.id);
  if (!current) return res.status(404).json({ error: 'Contacto no encontrado' });
  const v = contactFields(req.body, current);
  if (v.error) return res.status(400).json({ error: v.error });
  await updateContact(current.id, v.data);
  await insertEvents([{ type: 'comercial.contact.updated', userId: req.user.id, userName: req.user.name, detail: { id: current.id } }]);
  res.json({ ok: true });
}));

// CRM: oportunidades (eventos y ventas)
app.get('/api/comercial/opportunities', auth, COMERCIAL, wrap(async (req, res) => {
  res.json({ opportunities: await listOpportunities() });
}));

function oppFields(b, existing = {}) {
  const title = b.title !== undefined ? cleanText(b.title, 120) : existing.title;
  if (!title || title.length < 2) return { error: 'El título de la oportunidad es obligatorio' };
  const stage = b.stage !== undefined ? b.stage : existing.stage || 'lead';
  if (!STAGES.includes(stage)) return { error: 'Etapa no válida' };
  const estimatedValue = b.estimatedValue !== undefined ? Number(b.estimatedValue) : existing.estimatedValue ?? 0;
  if (!Number.isFinite(estimatedValue) || estimatedValue < 0) return { error: 'El valor estimado no es válido' };
  const probability = b.probability !== undefined ? Number(b.probability) : existing.probability ?? 20;
  if (!Number.isInteger(probability) || probability < 0 || probability > 100) return { error: 'La probabilidad debe estar entre 0 y 100' };
  const dates = {};
  for (const k of ['eventDate', 'expectedClose', 'nextActionDate']) {
    const value = b[k] !== undefined ? optDate(b[k]) : existing[k] ?? null;
    if (value === 'bad') return { error: 'Las fechas deben tener formato AAAA-MM-DD' };
    dates[k] = value;
  }
  return {
    data: {
      title,
      contactId: b.contactId !== undefined ? b.contactId || null : existing.contactId || null,
      eventName: b.eventName !== undefined ? cleanText(b.eventName, 120) : existing.eventName || '',
      eventDate: dates.eventDate,
      stage,
      estimatedValue,
      probability,
      expectedClose: dates.expectedClose,
      nextAction: b.nextAction !== undefined ? cleanText(b.nextAction, 200) : existing.nextAction || '',
      nextActionDate: dates.nextActionDate,
      notes: b.notes !== undefined ? cleanText(b.notes, 2000) : existing.notes || '',
    },
  };
}

app.post('/api/comercial/opportunities', auth, COMERCIAL, wrap(async (req, res) => {
  const v = oppFields(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const opp = { id: uid(), ...v.data, ownerId: req.user.id };
  await insertOpportunity(opp);
  await insertEvents([{ type: 'comercial.opportunity.created', userId: req.user.id, userName: req.user.name, detail: { id: opp.id, title: opp.title, stage: opp.stage } }]);
  res.status(201).json({ ok: true, id: opp.id });
}));

app.patch('/api/comercial/opportunities/:id', auth, COMERCIAL, wrap(async (req, res) => {
  const current = await getOpportunity(req.params.id);
  if (!current) return res.status(404).json({ error: 'Oportunidad no encontrada' });
  const v = oppFields(req.body, current);
  if (v.error) return res.status(400).json({ error: v.error });
  await updateOpportunity(current.id, v.data);
  const stageChanged = v.data.stage !== current.stage;
  await insertEvents([{
    type: stageChanged ? 'comercial.opportunity.stage' : 'comercial.opportunity.updated',
    userId: req.user.id,
    userName: req.user.name,
    detail: { id: current.id, from: current.stage, to: v.data.stage },
  }]);
  res.json({ ok: true });
}));

// Pedidos B2B
app.get('/api/comercial/orders', auth, COMERCIAL, wrap(async (req, res) => {
  res.json(await attachPhotoUrls({ orders: await listOrders() }));
}));

function orderFields(b, existing = {}) {
  const customer = b.customer !== undefined ? cleanText(b.customer, 120) : existing.customer;
  if (!customer || customer.length < 2) return { error: 'El cliente es obligatorio' };
  let items = existing.items;
  let total = existing.total;
  if (b.items !== undefined) {
    const parsed = parseOrderItems(b.items);
    if (parsed.error) return { error: parsed.error };
    items = parsed.items;
    total = parsed.total;
  }
  const deliveryDate = b.deliveryDate !== undefined ? optDate(b.deliveryDate) : existing.deliveryDate ?? null;
  if (deliveryDate === 'bad') return { error: 'La fecha de entrega debe tener formato AAAA-MM-DD' };
  const status = b.status !== undefined ? b.status : existing.status || 'pendiente';
  if (!ORDER_STATUSES.includes(status)) return { error: 'Estado de pedido no válido' };
  return {
    data: {
      customer,
      contactName: b.contactName !== undefined ? cleanText(b.contactName, 120) : existing.contactName || '',
      phone: b.phone !== undefined ? cleanText(b.phone, 30) : existing.phone || '',
      address: b.address !== undefined ? cleanText(b.address, 300) : existing.address || '',
      items,
      total,
      status,
      deliveryDate,
      deliveryWindow: b.deliveryWindow !== undefined ? cleanText(b.deliveryWindow, 40) : existing.deliveryWindow || '',
      assignedTo: b.assignedTo !== undefined ? cleanText(b.assignedTo, 120) : existing.assignedTo || '',
      notes: b.notes !== undefined ? cleanText(b.notes, 2000) : existing.notes || '',
    },
  };
}

app.post('/api/comercial/orders', auth, COMERCIAL, wrap(async (req, res) => {
  const v = orderFields({ ...req.body, status: 'pendiente' });
  if (v.error) return res.status(400).json({ error: v.error });
  const order = { id: uid(), ...v.data, createdBy: req.user.id };
  await insertOrder(order);
  await insertEvents([{ type: 'comercial.order.created', userId: req.user.id, userName: req.user.name, detail: { id: order.id, customer: order.customer, total: order.total } }]);
  res.status(201).json({ ok: true, id: order.id });
}));

app.patch('/api/comercial/orders/:id', auth, COMERCIAL, wrap(async (req, res) => {
  const current = await getOrder(req.params.id);
  if (!current) return res.status(404).json({ error: 'Pedido no encontrado' });
  const v = orderFields(req.body, current);
  if (v.error) return res.status(400).json({ error: v.error });

  const patch = { ...v.data };
  if (req.body.items !== undefined) patch.total = v.data.total;
  if (v.data.status !== current.status) {
    patch.deliveredAt = v.data.status === 'entregado' ? new Date().toISOString() : null;
  }
  await updateOrder(current.id, patch);
  if (v.data.status !== current.status) {
    await insertEvents([{
      type: 'comercial.order.status',
      userId: req.user.id,
      userName: req.user.name,
      detail: { id: current.id, customer: current.customer, from: current.status, to: v.data.status },
    }]);
  }
  res.json({ ok: true });
}));

// Foto de entrega (la toma el repartidor desde el celular)
app.post('/api/comercial/orders/:id/proof', auth, COMERCIAL, upload.single('photo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Formato de imagen no válido' });
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  const id = uid();
  const relPath = `comercial/pedidos/${order.id}/${id}${ALLOWED_MIME[req.file.mimetype]}`;
  await uploadPhoto(relPath, req.file.buffer, req.file.mimetype);
  await updateOrder(order.id, { proof: { file: relPath, at: new Date().toISOString(), by: req.user.name } });
  await insertEvents([{ type: 'comercial.order.proof', userId: req.user.id, userName: req.user.name, detail: { id: order.id, customer: order.customer } }]);
  res.status(201).json({ ok: true });
}));

// ---------- Errores ----------
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'La foto supera 15 MB' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud no válida' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
});

export default app;
