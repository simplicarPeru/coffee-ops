(() => {
  const $ = (sel) => document.querySelector(sel);
  const { api, esc, toast, modal } = App;

  const STAGE_LABEL = { lead: 'Lead', contactado: 'Contactado', propuesta: 'Propuesta', negociacion: 'Negociación', ganado: 'Ganado', perdido: 'Perdido' };
  const STATUS_LABEL = { pendiente: 'Pendiente', preparando: 'Preparando', en_ruta: 'En ruta', entregado: 'Entregado', cancelado: 'Cancelado' };
  const NEXT_STATUS = { pendiente: 'preparando', preparando: 'en_ruta', en_ruta: 'entregado' };
  const money = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 2 })}`;
  const fmtDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' }) : '—');

  let me = null;
  let tab = 'resumen';
  let sub = 'opps';
  let today = App.todayISO();
  let contacts = [];
  let opps = [];
  let orders = [];

  function setError(msg) {
    $('#error').hidden = !msg;
    $('#error').textContent = msg || '';
  }

  function show(name) {
    tab = name;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const t of ['resumen', 'crm', 'pedidos']) $(`#tab-${t}`).hidden = t !== name;
    $('#stage-filter').hidden = !(name === 'crm' && sub === 'opps');
    $('#contact-search').hidden = !(name === 'crm' && sub === 'contacts');
    $('#new-crm').hidden = name !== 'crm';
    $('#new-order').hidden = name !== 'pedidos';
    const url = new URL(location.href);
    url.searchParams.set('tab', name);
    history.replaceState(null, '', url);
    ({ resumen: loadSummary, crm: loadCrm, pedidos: loadOrders })[name]();
  }

  // ---------- Resumen ----------
  async function loadSummary() {
    try {
      const d = await api('GET', '/api/comercial/summary');
      setError('');
      today = d.today;
      $('#subtitle').textContent = `${App.fmtDate(d.today)} · resumen comercial`;
      const p = d.pipeline;
      const kpis = [
        { label: 'Pipeline abierto', value: money(p.openValue), detail: `${p.openCount} oportunidades · ponderado ${money(p.weightedValue)}` },
        { label: 'Cierre esperado este mes', value: money(p.closeThisMonth.value), detail: `${p.closeThisMonth.count} oportunidades · ponderado ${money(p.closeThisMonth.weighted)}`, cls: '' },
        { label: 'Ganado este mes', value: money(p.wonThisMonth.value), detail: `${p.wonThisMonth.count} cerradas`, cls: 'good' },
        { label: 'Seguimientos vencidos', value: `${d.crm.overdue.length}`, detail: d.crm.dueToday.length ? `${d.crm.dueToday.length} para hoy` : 'Nada para hoy', cls: d.crm.overdue.length ? 'alert' : '' },
        { label: 'Pedidos abiertos', value: `${d.orders.openCount}`, detail: `${d.orders.today.length} entregas hoy`, cls: '' },
        { label: 'Entregados este mes', value: money(d.orders.deliveredThisMonth.value), detail: `${d.orders.deliveredThisMonth.count} pedidos`, cls: 'good' },
      ];
      $('#kpis').innerHTML = kpis.map((k) => `
        <div class="card kpi ${k.cls || ''}">
          <div class="label">${esc(k.label)}</div>
          <div class="value">${esc(k.value)}</div>
          <div class="detail">${esc(k.detail)}</div>
        </div>`).join('');

      const max = Math.max(1, ...d.byStage.map((s) => s.value));
      $('#pipeline-note').textContent = `${d.crm.contacts} contactos · ${d.crm.newContactsThisMonth} nuevos este mes`;
      $('#stages').innerHTML = d.byStage.map((s) => `
        <div class="stage-row">
          <div class="stage-name">${esc(STAGE_LABEL[s.stage])} <span class="muted small">${s.count}</span></div>
          <div class="progress"><span style="width:${Math.round((s.value / max) * 100)}%"></span></div>
          <div class="num small">${money(s.value)}</div>
        </div>`).join('');

      const oppItem = (o) => `
        <div class="list-item">
          <div><strong>${esc(o.title)}</strong> <span class="muted small">${esc(o.contact)}</span></div>
          <div class="small">${esc(o.nextAction || 'Sin próxima acción')} · <span class="${o.nextActionDate < today ? 'overdue' : ''}">${fmtDay(o.nextActionDate)}</span></div>
        </div>`;
      $('#followups').innerHTML = [...d.crm.overdue, ...d.crm.dueToday].map(oppItem).join('') || '<p class="empty">Sin seguimientos pendientes.</p>';

      const orderItem = (o) => `
        <div class="list-item">
          <div><strong>${esc(o.customer)}</strong> <span class="muted small">${esc(o.deliveryWindow || '')}</span></div>
          <div class="small">${money(o.total)} · ${esc(STATUS_LABEL[o.status])} ${o.assignedTo ? `· ${esc(o.assignedTo)}` : ''}</div>
        </div>`;
      $('#today-orders').innerHTML = d.orders.today.map(orderItem).join('') || '<p class="empty">No hay entregas hoy.</p>';
      $('#late-orders').innerHTML = d.orders.late.map((o) => `${orderItem(o)}`).join('') || '<p class="empty">Ningún pedido atrasado.</p>';
    } catch (err) {
      setError(err.message);
    }
  }

  // ---------- CRM ----------
  async function loadCrm() {
    try {
      const [c, o] = await Promise.all([api('GET', '/api/comercial/contacts'), api('GET', '/api/comercial/opportunities')]);
      contacts = c.contacts;
      opps = o.opportunities;
      setError('');
      $('#subtitle').textContent = `${opps.length} oportunidades · ${contacts.length} contactos`;
      if (!$('#stage-filter').options.length) {
        $('#stage-filter').innerHTML = `<option value="">Todas las etapas</option>${Object.entries(STAGE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}`;
      }
      renderCrm();
    } catch (err) {
      setError(err.message);
    }
  }

  function renderCrm() {
    if (sub === 'opps') {
      const filter = $('#stage-filter').value;
      const list = opps.filter((o) => !filter || o.stage === filter);
      const contactName = (id) => contacts.find((c) => c.id === id)?.name || '—';
      $('#crm-table').innerHTML = `
        <thead><tr><th>Oportunidad</th><th>Contacto</th><th>Evento</th><th>Etapa</th><th class="num">Valor</th><th class="num">Prob.</th><th>Próxima acción</th><th></th></tr></thead>
        <tbody>${list.map((o) => {
          const overdue = o.nextActionDate && o.nextActionDate < today && !['ganado', 'perdido'].includes(o.stage);
          return `
          <tr>
            <td><strong>${esc(o.title)}</strong></td>
            <td>${esc(contactName(o.contactId))}</td>
            <td>${esc(o.eventName || '—')} ${o.eventDate ? `<span class="muted small">${fmtDay(o.eventDate)}</span>` : ''}</td>
            <td>
              <select class="select small-select" data-stage="${esc(o.id)}" aria-label="Etapa">
                ${Object.entries(STAGE_LABEL).map(([v, l]) => `<option value="${v}" ${o.stage === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </td>
            <td class="num">${money(o.estimatedValue)}</td>
            <td class="num">${o.probability}%</td>
            <td class="${overdue ? 'overdue' : ''}">${esc(o.nextAction || '—')} <span class="small">${fmtDay(o.nextActionDate)}</span></td>
            <td class="num"><button class="btn ghost small" data-edit-opp="${esc(o.id)}">Editar</button></td>
          </tr>`;
        }).join('')}</tbody>`;
    } else {
      const q = ($('#contact-search').value || '').toLowerCase();
      const list = contacts.filter((c) => !q || [c.name, c.company, c.phone, c.email, c.tags.join(' ')].join(' ').toLowerCase().includes(q));
      $('#crm-table').innerHTML = `
        <thead><tr><th>Nombre</th><th>Empresa / cargo</th><th>Teléfono</th><th>Correo</th><th>Origen</th><th>Etiquetas</th><th></th></tr></thead>
        <tbody>${list.map((c) => `
          <tr>
            <td><strong>${esc(c.name)}</strong></td>
            <td>${esc(c.company)} ${c.roleTitle ? `<span class="muted small">· ${esc(c.roleTitle)}</span>` : ''}</td>
            <td>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</td>
            <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</td>
            <td>${esc(c.source || '—')}</td>
            <td class="small">${c.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')}</td>
            <td class="num"><button class="btn ghost small" data-edit-contact="${esc(c.id)}">Editar</button></td>
          </tr>`).join('')}</tbody>`;
    }
  }

  function contactOptions(selected) {
    return `<option value="">— sin contacto —</option>${contacts.map((c) => `<option value="${esc(c.id)}" ${selected === c.id ? 'selected' : ''}>${esc(c.name)}${c.company ? ` · ${esc(c.company)}` : ''}</option>`).join('')}`;
  }

  function stageOptions(selected) {
    return Object.entries(STAGE_LABEL).map(([v, l]) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${l}</option>`).join('');
  }

  function contactModal(c) {
    const body = `
      <label class="field"><span>Nombre</span><input class="input" name="name" required maxlength="80" value="${esc(c?.name || '')}"></label>
      <label class="field"><span>Empresa</span><input class="input" name="company" maxlength="120" value="${esc(c?.company || '')}"></label>
      <label class="field"><span>Cargo</span><input class="input" name="roleTitle" maxlength="80" value="${esc(c?.roleTitle || '')}"></label>
      <div class="grid-2 tight">
        <label class="field"><span>Teléfono</span><input class="input" name="phone" inputmode="tel" maxlength="30" value="${esc(c?.phone || '')}"></label>
        <label class="field"><span>Correo</span><input class="input" name="email" type="email" maxlength="120" value="${esc(c?.email || '')}"></label>
      </div>
      <label class="field"><span>Origen</span><input class="input" name="source" placeholder="Evento, referido, web…" maxlength="40" value="${esc(c?.source || '')}"></label>
      <label class="field"><span>Etiquetas (separadas por coma)</span><input class="input" name="tags" maxlength="200" value="${esc((c?.tags || []).join(', '))}"></label>
      <label class="field"><span>Notas</span><textarea class="input" name="notes" rows="3" maxlength="2000">${esc(c?.notes || '')}</textarea></label>`;
    modal(c ? `Editar ${c.name}` : 'Nuevo contacto', body, async (fd) => {
      const payload = Object.fromEntries(fd.entries());
      if (c) await api('PATCH', `/api/comercial/contacts/${encodeURIComponent(c.id)}`, payload);
      else await api('POST', '/api/comercial/contacts', payload);
      toast(c ? 'Contacto actualizado' : 'Contacto creado');
      loadCrm();
    }, c ? 'Guardar' : 'Crear contacto');
  }

  function oppModal(o) {
    const body = `
      <label class="field"><span>Título</span><input class="input" name="title" required maxlength="120" value="${esc(o?.title || '')}" placeholder="Ej.: Café para la feria de Barranco"></label>
      <label class="field"><span>Contacto</span><select class="select" name="contactId">${contactOptions(o?.contactId)}</select></label>
      <label class="field"><span>Evento</span><input class="input" name="eventName" maxlength="120" value="${esc(o?.eventName || '')}"></label>
      <div class="grid-2 tight">
        <label class="field"><span>Fecha del evento</span><input class="input" type="date" name="eventDate" value="${esc(o?.eventDate || '')}"></label>
        <label class="field"><span>Etapa</span><select class="select" name="stage">${stageOptions(o?.stage || 'lead')}</select></label>
      </div>
      <div class="grid-2 tight">
        <label class="field"><span>Valor estimado (S/)</span><input class="input" type="number" min="0" step="0.01" name="estimatedValue" value="${esc(o?.estimatedValue ?? 0)}"></label>
        <label class="field"><span>Probabilidad (%)</span><input class="input" type="number" min="0" max="100" step="1" name="probability" value="${esc(o?.probability ?? 20)}"></label>
      </div>
      <label class="field"><span>Cierre esperado</span><input class="input" type="date" name="expectedClose" value="${esc(o?.expectedClose || '')}"></label>
      <div class="grid-2 tight">
        <label class="field"><span>Próxima acción</span><input class="input" name="nextAction" maxlength="200" value="${esc(o?.nextAction || '')}"></label>
        <label class="field"><span>Fecha de la acción</span><input class="input" type="date" name="nextActionDate" value="${esc(o?.nextActionDate || '')}"></label>
      </div>
      <label class="field"><span>Notas</span><textarea class="input" name="notes" rows="2" maxlength="2000">${esc(o?.notes || '')}</textarea></label>`;
    modal(o ? 'Editar oportunidad' : 'Nueva oportunidad', body, async (fd) => {
      const payload = Object.fromEntries(fd.entries());
      if (!payload.contactId) payload.contactId = null;
      if (o) await api('PATCH', `/api/comercial/opportunities/${encodeURIComponent(o.id)}`, payload);
      else await api('POST', '/api/comercial/opportunities', payload);
      toast(o ? 'Oportunidad actualizada' : 'Oportunidad creada');
      loadCrm();
    }, o ? 'Guardar' : 'Crear oportunidad');
  }

  // ---------- Pedidos B2B ----------
  const itemsText = (items) => (items || []).map((i) => `${i.qty} x ${i.product} @ ${i.unitPrice}`).join('\n');

  async function loadOrders() {
    try {
      const d = await api('GET', '/api/comercial/orders');
      orders = d.orders;
      setError('');
      $('#subtitle').textContent = `${orders.filter((o) => !['entregado', 'cancelado'].includes(o.status)).length} pedidos abiertos`;
      renderOrders();
    } catch (err) {
      setError(err.message);
    }
  }

  function renderOrders() {
    $('#orders-table').innerHTML = `
      <thead><tr><th>Cliente</th><th>Entrega</th><th>Productos</th><th class="num">Total</th><th>Estado</th><th>Asignado</th><th>Prueba de entrega</th><th></th></tr></thead>
      <tbody>${orders.map((o) => {
        const late = o.deliveryDate && o.deliveryDate < today && !['entregado', 'cancelado'].includes(o.status);
        const next = NEXT_STATUS[o.status];
        const proof = o.proof?.url
          ? `<a href="${esc(o.proof.url)}" target="_blank" rel="noopener"><img class="thumb-sm" src="${esc(o.proof.url)}" alt="Entrega"></a>`
          : `<label class="camera-btn small-cam">📷 Foto<input type="file" accept="image/*" capture="environment" data-proof="${esc(o.id)}"></label>`;
        return `
        <tr>
          <td><strong>${esc(o.customer)}</strong><div class="small muted">${esc(o.contactName)} ${o.phone ? `· ${esc(o.phone)}` : ''}</div></td>
          <td class="${late ? 'overdue' : ''}">${fmtDay(o.deliveryDate)} <div class="small muted">${esc(o.deliveryWindow || '')}</div></td>
          <td class="small">${o.items.map((i) => `${i.qty} × ${esc(i.product)}`).join('<br>')}</td>
          <td class="num">${money(o.total)}</td>
          <td>
            <select class="select small-select" data-status="${esc(o.id)}" aria-label="Estado">
              ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${o.status === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            ${next ? `<div><button class="btn ghost small" data-advance="${esc(o.id)}" data-to="${next}">→ ${STATUS_LABEL[next]}</button></div>` : ''}
          </td>
          <td>${esc(o.assignedTo || '—')}</td>
          <td>${proof}${o.status === 'entregado' && !o.proof ? '<div class="small overdue">Sin foto</div>' : ''}</td>
          <td class="num"><button class="btn ghost small" data-edit-order="${esc(o.id)}">Editar</button></td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  function orderModal(o) {
    const body = `
      <label class="field"><span>Cliente (empresa)</span><input class="input" name="customer" required maxlength="120" value="${esc(o?.customer || '')}"></label>
      <div class="grid-2 tight">
        <label class="field"><span>Contacto</span><input class="input" name="contactName" maxlength="120" value="${esc(o?.contactName || '')}"></label>
        <label class="field"><span>Teléfono</span><input class="input" name="phone" inputmode="tel" maxlength="30" value="${esc(o?.phone || '')}"></label>
      </div>
      <label class="field"><span>Dirección de entrega</span><input class="input" name="address" maxlength="300" value="${esc(o?.address || '')}"></label>
      <div class="grid-2 tight">
        <label class="field"><span>Fecha de entrega</span><input class="input" type="date" name="deliveryDate" value="${esc(o?.deliveryDate || '')}"></label>
        <label class="field"><span>Ventana horaria</span><input class="input" name="deliveryWindow" placeholder="Ej.: 9:00–11:00" maxlength="40" value="${esc(o?.deliveryWindow || '')}"></label>
      </div>
      <label class="field"><span>Productos (una línea por producto)</span>
        <textarea class="input" name="items" rows="4" required placeholder="2 x Café de especialidad 1kg @ 65">${esc(itemsText(o?.items))}</textarea>
        <span class="hint">Formato: cantidad x producto @ precio unitario. El total se calcula solo.</span>
      </label>
      <label class="field"><span>Asignado a (repartidor)</span><input class="input" name="assignedTo" maxlength="120" value="${esc(o?.assignedTo || '')}"></label>
      <label class="field"><span>Notas</span><textarea class="input" name="notes" rows="2" maxlength="2000">${esc(o?.notes || '')}</textarea></label>`;
    modal(o ? `Editar pedido de ${o.customer}` : 'Nuevo pedido B2B', body, async (fd) => {
      const payload = Object.fromEntries(fd.entries());
      if (o) await api('PATCH', `/api/comercial/orders/${encodeURIComponent(o.id)}`, payload);
      else await api('POST', '/api/comercial/orders', payload);
      toast(o ? 'Pedido actualizado' : 'Pedido creado');
      loadOrders();
    }, o ? 'Guardar' : 'Crear pedido');
  }

  async function setOrderStatus(id, status) {
    try {
      await api('PATCH', `/api/comercial/orders/${encodeURIComponent(id)}`, { status });
      toast(`Pedido: ${STATUS_LABEL[status]}`);
      loadOrders();
    } catch (err) {
      toast(err.message);
    }
  }

  async function uploadProof(id, file) {
    const form = new FormData();
    form.append('photo', file, 'entrega.jpg');
    try {
      await api('POST', `/api/comercial/orders/${encodeURIComponent(id)}/proof`, form);
      toast('Foto de entrega guardada');
      loadOrders();
    } catch (err) {
      toast(`No se subió la foto: ${err.message}`);
    }
  }

  // ---------- Arranque ----------
  async function init() {
    if (!App.token()) return (location.href = '/login');
    try {
      me = (await api('GET', '/api/me')).user;
    } catch {
      return;
    }
    if (!['admin', 'administrativo', 'comercial'].includes(me.role)) return (location.href = '/tienda');
    $('#who').textContent = `${me.name}`;
    if (me.role !== 'comercial') $('#back-panel').hidden = false;

    $('#nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) show(b.dataset.tab);
    });
    document.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => {
      sub = b.dataset.sub;
      renderCrm();
      $('#stage-filter').hidden = sub !== 'opps';
      $('#contact-search').hidden = sub !== 'contacts';
    }));
    $('#stage-filter').addEventListener('change', renderCrm);
    $('#contact-search').addEventListener('input', renderCrm);
    $('#new-crm').addEventListener('click', () => (sub === 'opps' ? oppModal(null) : contactModal(null)));
    $('#new-order').addEventListener('click', () => orderModal(null));
    $('#logout').addEventListener('click', App.signOut);

    $('#crm-table').addEventListener('click', (e) => {
      const eo = e.target.closest('[data-edit-opp]');
      const ec = e.target.closest('[data-edit-contact]');
      if (eo) oppModal(opps.find((o) => o.id === eo.dataset.editOpp));
      if (ec) contactModal(contacts.find((c) => c.id === ec.dataset.editContact));
    });
    $('#crm-table').addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-stage]');
      if (!sel) return;
      try {
        await api('PATCH', `/api/comercial/opportunities/${encodeURIComponent(sel.dataset.stage)}`, { stage: sel.value });
        toast(`Etapa: ${STAGE_LABEL[sel.value]}`);
        loadCrm();
      } catch (err) {
        toast(err.message);
      }
    });

    $('#orders-table').addEventListener('click', (e) => {
      const adv = e.target.closest('[data-advance]');
      const edit = e.target.closest('[data-edit-order]');
      if (adv) return setOrderStatus(adv.dataset.advance, adv.dataset.to);
      if (edit) orderModal(orders.find((o) => o.id === edit.dataset.editOrder));
    });
    $('#orders-table').addEventListener('change', (e) => {
      const st = e.target.closest('[data-status]');
      if (st) return setOrderStatus(st.dataset.status, st.value);
      const pr = e.target.closest('[data-proof]');
      if (pr && pr.files?.[0]) uploadProof(pr.dataset.proof, pr.files[0]);
    });

    const initial = new URL(location.href).searchParams.get('tab');
    show(['resumen', 'crm', 'pedidos'].includes(initial) ? initial : 'resumen');
  }

  init();
})();
