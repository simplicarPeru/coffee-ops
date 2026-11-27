// Acceso a datos del módulo comercial: contactos, oportunidades (CRM) y pedidos B2B.
import { query } from './db.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

// ---------- Contactos ----------
const mapContact = (r) => ({
  id: r.id,
  name: r.name,
  company: r.company,
  roleTitle: r.role_title,
  phone: r.phone,
  email: r.email,
  source: r.source,
  tags: r.tags || [],
  notes: r.notes,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function listContacts() {
  return (await query('select * from crm_contacts order by name')).map(mapContact);
}

export async function insertContact(c) {
  await query(
    `insert into crm_contacts (id, name, company, role_title, phone, email, source, tags, notes, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [c.id, c.name, c.company, c.roleTitle, c.phone, c.email, c.source, c.tags, c.notes, c.createdBy],
  );
}

const CONTACT_COLS = {
  name: 'name', company: 'company', roleTitle: 'role_title', phone: 'phone',
  email: 'email', source: 'source', tags: 'tags', notes: 'notes',
};

export async function updateContact(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(CONTACT_COLS)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return;
  params.push(id);
  await query(`update crm_contacts set ${sets.join(', ')}, updated_at = now() where id = $${params.length}`, params);
}

// ---------- Oportunidades ----------
const mapOpp = (r) => ({
  id: r.id,
  title: r.title,
  contactId: r.contact_id,
  eventName: r.event_name,
  eventDate: r.event_date,
  stage: r.stage,
  estimatedValue: Number(r.estimated_value),
  probability: r.probability,
  expectedClose: r.expected_close,
  nextAction: r.next_action,
  nextActionDate: r.next_action_date,
  notes: r.notes,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function listOpportunities() {
  return (await query('select * from crm_opportunities order by coalesce(next_action_date, expected_close, event_date) nulls last, title')).map(mapOpp);
}

export async function insertOpportunity(o) {
  await query(
    `insert into crm_opportunities (id, title, contact_id, event_name, event_date, stage, estimated_value,
       probability, expected_close, next_action, next_action_date, notes, owner_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [o.id, o.title, o.contactId, o.eventName, o.eventDate, o.stage, o.estimatedValue, o.probability,
      o.expectedClose, o.nextAction, o.nextActionDate, o.notes, o.ownerId],
  );
}

const OPP_COLS = {
  title: 'title', contactId: 'contact_id', eventName: 'event_name', eventDate: 'event_date',
  stage: 'stage', estimatedValue: 'estimated_value', probability: 'probability',
  expectedClose: 'expected_close', nextAction: 'next_action', nextActionDate: 'next_action_date',
  notes: 'notes',
};

export async function updateOpportunity(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(OPP_COLS)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return;
  params.push(id);
  await query(`update crm_opportunities set ${sets.join(', ')}, updated_at = now() where id = $${params.length}`, params);
}

export async function getOpportunity(id) {
  const r = (await query('select * from crm_opportunities where id = $1', [id]))[0];
  return r ? mapOpp(r) : null;
}

// ---------- Pedidos B2B ----------
const mapOrder = (r) => ({
  id: r.id,
  customer: r.customer,
  contactName: r.contact_name,
  phone: r.phone,
  address: r.address,
  items: r.items || [],
  total: Number(r.total),
  status: r.status,
  deliveryDate: r.delivery_date,
  deliveryWindow: r.delivery_window,
  assignedTo: r.assigned_to,
  notes: r.notes,
  proof: r.proof || null,
  deliveredAt: iso(r.delivered_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export async function listOrders() {
  return (await query('select * from b2b_orders order by delivery_date nulls last, created_at')).map(mapOrder);
}

export async function getOrder(id) {
  const r = (await query('select * from b2b_orders where id = $1', [id]))[0];
  return r ? mapOrder(r) : null;
}

export async function insertOrder(o) {
  await query(
    `insert into b2b_orders (id, customer, contact_name, phone, address, items, total, status,
       delivery_date, delivery_window, assigned_to, notes, created_by)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
    [o.id, o.customer, o.contactName, o.phone, o.address, JSON.stringify(o.items), o.total, o.status,
      o.deliveryDate, o.deliveryWindow, o.assignedTo, o.notes, o.createdBy],
  );
}

const ORDER_COLS = {
  customer: 'customer', contactName: 'contact_name', phone: 'phone', address: 'address',
  deliveryDate: 'delivery_date', deliveryWindow: 'delivery_window', assignedTo: 'assigned_to',
  notes: 'notes', status: 'status', deliveredAt: 'delivered_at',
};

export async function updateOrder(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(ORDER_COLS)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (patch.items !== undefined) {
    params.push(JSON.stringify(patch.items));
    sets.push(`items = $${params.length}::jsonb`);
    params.push(patch.total);
    sets.push(`total = $${params.length}`);
  }
  if (patch.proof !== undefined) {
    params.push(JSON.stringify(patch.proof));
    sets.push(`proof = $${params.length}::jsonb`);
  }
  if (!sets.length) return;
  params.push(id);
  await query(`update b2b_orders set ${sets.join(', ')}, updated_at = now() where id = $${params.length}`, params);
}
