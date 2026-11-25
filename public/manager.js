(() => {
  const $ = (sel) => document.querySelector(sel);
  const { api, esc, toast, modal } = App;

  const MOMENT_KEYS = ['opening', 'midday', 'closing'];
  const ROLE_LABEL = { admin: 'Administrador', administrativo: 'Administrativo', leader: 'Líder', barista: 'Barista' };
  const STATE_LABEL = { complete: 'Completo', in_progress: 'En curso', late: 'Atrasado', incomplete: 'Incompleto', pending: 'Pendiente' };

  let me = null;
  let config = null;
  let statusLabel = {};
  let currentView = null;

  const isAdmin = () => me.role === 'admin';
  // Aprobar es función del rol administrativo (cualquier persona con ese rol)
  const canApprove = () => me.role === 'administrativo';
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' }) : '');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' }) : '');

  function statusPill(status) {
    const cls = status === 'awaiting' ? 'in_progress' : status === 'approved' ? 'complete' : status === 'rejected' || status === 'late' ? 'late' : status === 'not_opened' ? 'incomplete' : 'pending';
    return `<span class="pill ${cls}">${esc(statusLabel[status] || status)}</span>`;
  }

  function momentPill(state) {
    const cls = state;
    return `<span class="pill ${cls}">${esc(STATE_LABEL[state])}</span>`;
  }

  function show(view) {
    currentView = view;
    for (const v of ['hoy', 'reportes', 'tiendas', 'usuarios']) $(`#view-${v}`).hidden = v !== view;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const loaders = { hoy: loadToday, reportes: loadReport, tiendas: loadStores, usuarios: loadUsers };
    loaders[view]();
  }

  function buildNav() {
    const items = [['hoy', 'Hoy'], ['reportes', 'Reportes']];
    if (isAdmin()) items.push(['tiendas', 'Tiendas'], ['usuarios', 'Usuarios']);
    $('#nav').innerHTML = items.map(([v, l]) => `<button data-view="${v}">${l}</button>`).join('');
    $('#nav').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]');
      if (b) {
        const url = new URL(location.href);
        url.searchParams.set('view', b.dataset.view);
        history.replaceState(null, '', url);
        show(b.dataset.view);
      }
    });
  }

  function setError(msg) {
    const el = $('#error');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  // ---------- Hoy ----------
  function renderKpis(data) {
    const s = data.summary;
    const kpis = [
      { label: 'Abiertas (aprobadas)', value: `${s.approved} / ${s.total}`, detail: s.approved === s.total ? 'Todas abiertas y aprobadas' : `${s.total - s.approved} sin aprobar`, cls: s.approved === s.total ? 'good' : '' },
      { label: 'Por aprobar', value: `${s.awaiting}`, detail: s.awaiting ? 'Apertura completa, falta revisar' : 'Nada pendiente de revisar', cls: s.awaiting ? 'alert' : '' },
      { label: 'Atrasadas', value: `${s.late}`, detail: s.late ? 'Pasó su hora de apertura' : 'Ninguna atrasada', cls: s.late ? 'alert' : '' },
      { label: 'Personal presente', value: `${s.presentNow} / ${s.expectedStaff}`, detail: 'Líderes y baristas en tienda', cls: '' },
      { label: 'Mediodía completado', value: `${s.middayDone} / ${s.total}`, detail: 'Calibración, limpieza y vitrina', cls: '' },
      { label: 'Cierre completado', value: `${s.closingDone} / ${s.total}`, detail: 'Arqueo y cierre de equipos', cls: '' },
    ];
    $('#kpis').innerHTML = kpis.map((k) => `
      <div class="card kpi ${k.cls === 'alert' ? 'alert' : k.cls === 'good' ? 'good' : ''}">
        <div class="label">${esc(k.label)}</div>
        <div class="value">${esc(k.value)}</div>
        <div class="detail">${esc(k.detail)}</div>
      </div>`).join('');
  }

  function openingCell(store) {
    const o = store.moments.opening;
    let time = '';
    if (store.openedAt) {
      time = `Abrió ${store.openedAt}${store.onTime ? ' · a tiempo' : ` · tarde (límite ${store.openBy})`}`;
    } else {
      time = `Límite ${store.openBy}`;
    }
    const approval = store.approval
      ? `<div class="time">${store.approval.status === 'approved' ? 'Aprobada' : 'Rechazada'} por ${esc(store.approval.byName)} · ${fmtTime(store.approval.at)}</div>`
      : '';
    const actions = store.status === 'awaiting' && canApprove()
      ? `<div class="actions">
           <button class="btn approve small" data-approve="${esc(store.id)}">Aprobar</button>
           <button class="btn reject small" data-reject="${esc(store.id)}">Rechazar</button>
         </div>`
      : '';
    return `
      <div class="cell open-status" data-label="Apertura">
        <div class="cell-top">${statusPill(store.status)}<span>${o.done}/${o.total}</span></div>
        <div class="progress ${o.state}"><span style="width:${o.total ? Math.round((o.done / o.total) * 100) : 0}%"></span></div>
        <div class="time">${esc(time)}</div>
        ${approval}
        ${actions}
      </div>`;
  }

  function momentCell(label, m) {
    const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
    return `
      <div class="cell" data-label="${esc(label)}">
        <div class="cell-top">${momentPill(m.state)}<span>${m.done}/${m.total}</span></div>
        <div class="progress ${m.state}"><span style="width:${pct}%"></span></div>
      </div>`;
  }

  function renderBoard(data) {
    $('#rows').innerHTML = data.stores.map((s) => {
      const dots = s.presence.members.map((m) => `<i class="${m.present ? 'on' : ''}" title="${esc(m.name)} ${m.present ? '· dentro desde ' + m.since : '· fuera'}"></i>`).join('');
      return `
        <div class="board-row" data-store="${esc(s.id)}" role="button" tabindex="0">
          <div class="store-name">
            <span class="open-dot ${s.status === 'approved' ? 'on' : ''}"></span>
            <div>
              <div>${esc(s.name)}</div>
              <div class="small muted">${s.leader ? 'Líder: ' + esc(s.leader) : 'Sin líder asignado'}</div>
            </div>
          </div>
          ${openingCell(s)}
          ${momentCell('Mediodía', s.moments.midday)}
          ${momentCell('Cierre', s.moments.closing)}
          <div class="small muted" style="grid-column:1 / -1">Personal: <span class="dots">${dots || '—'}</span> ${s.presence.present}/${s.presence.total} dentro</div>
        </div>`;
    }).join('') || '<p class="empty" style="padding:20px">No hay tiendas configuradas.</p>';
  }

  async function loadToday() {
    const date = $('#date').value || App.todayISO();
    try {
      const data = await api('GET', `/api/overview?date=${encodeURIComponent(date)}`);
      setError('');
      $('#subtitle').textContent = `${App.fmtDate(data.date)}${data.date === data.today ? ` · actualizado ${data.now}` : ' · registro histórico'}`;
      renderKpis(data);
      renderBoard(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function decide(storeId, decision) {
    const date = $('#date').value || App.todayISO();
    let note = '';
    if (decision === 'reject') {
      note = prompt('Motivo del rechazo (lo verá el líder):') || '';
      if (!note.trim()) return;
    }
    try {
      await api('POST', `/api/stores/${encodeURIComponent(storeId)}/approval`, { date, decision: decision === 'approve' ? 'approve' : 'reject', note });
      toast(decision === 'approve' ? 'Apertura aprobada' : 'Apertura rechazada');
      loadToday();
      if (!$('#drawer').classList.contains('open')) return;
      openDrawer(storeId);
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- Detalle de tienda ----------
  async function openDrawer(storeId) {
    $('#drawer').classList.add('open');
    $('#backdrop').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#drawer-body').innerHTML = '<p class="muted">Cargando…</p>';
    const date = $('#date').value || App.todayISO();
    try {
      const [data, events] = await Promise.all([
        api('GET', `/api/stores/${encodeURIComponent(storeId)}/checks?date=${encodeURIComponent(date)}`),
        api('GET', `/api/stores/${encodeURIComponent(storeId)}/events`).catch(() => ({ events: [] })),
      ]);
      $('#drawer-title').textContent = data.name;
      $('#drawer-sub').textContent = `${App.fmtDate(data.date)} · Líder: ${data.leader || '—'}`;

      const approvalBanner = data.approval
        ? `<div class="banner ${data.approval.status === 'approved' ? 'ok' : 'bad'}">
             ${data.approval.status === 'approved' ? 'Aprobada' : 'Rechazada'} por <strong>${esc(data.approval.byName)}</strong> a las ${fmtTime(data.approval.at)}
             ${data.approval.note ? `· “${esc(data.approval.note)}”` : ''}
           </div>`
        : data.status === 'awaiting'
          ? `<div class="banner warn">Apertura completa. ${canApprove() ? 'Falta tu revisión.' : 'Pendiente de revisión por el área administrativa.'}</div>`
          : '';

      const actions = data.status === 'awaiting' && canApprove()
        ? `<div class="actions" style="margin-bottom:14px">
             <button class="btn approve" data-approve="${esc(data.id)}">Aprobar apertura</button>
             <button class="btn reject" data-reject="${esc(data.id)}">Rechazar</button>
           </div>`
        : '';

      const presence = `
        <section class="section">
          <h3><span>Personal</span><span>${data.presence.present} / ${data.presence.total} dentro</span></h3>
          <div class="roster">${data.presence.members.map((m) => `
            <span class="chip ${m.present ? 'in' : ''}">${esc(m.name)} <span class="role">${m.role === 'leader' ? 'líder' : 'barista'}${m.present ? ` · ${m.since} · ${m.method === 'foto' ? 'foto' : 'ubicación'}` : ''}</span></span>`).join('') || '<span class="empty">Sin personal asignado</span>'}
          </div>
        </section>`;

      const moments = MOMENT_KEYS.map((key) => {
        const m = data.moments[key];
        const items = m.items.map((item) => {
          const who = item.done
            ? (item.type === 'check'
              ? `Marcado por ${esc(item.by)} · ${fmtTime(item.at)}`
              : `${item.photos.length} foto(s) · última ${fmtTime(item.photos.at(-1)?.at)} por ${esc(item.photos.at(-1)?.by)}`)
            : 'Pendiente';
          const photos = item.photos.length
            ? `<div class="photo-grid">${item.photos.map((p) => `
                <a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.by)} · ${fmtTime(p.at)}">
                  <img src="${esc(p.url)}" alt="${esc(item.label)}" loading="lazy">
                </a>`).join('')}</div>`
            : '';
          return `
            <div class="item-row">
              <span class="tick ${item.done ? 'on' : ''}">${item.done ? '✓' : ''}</span>
              <div class="item-body">
                <div>${esc(item.label)}</div>
                <div class="who">${who}</div>
                ${photos}
              </div>
            </div>`;
        }).join('');
        return `
          <section class="section">
            <h3><span>${esc(m.label)}</span> ${momentPill(m.state)}</h3>
            <div class="progress ${m.state}" style="margin-bottom:6px"><span style="width:${m.total ? Math.round((m.done / m.total) * 100) : 0}%"></span></div>
            <p class="small muted" style="margin:0 0 6px">Límite ${m.deadline}${m.lastAt ? ` · último registro ${fmtTime(m.lastAt)}` : ''}</p>
            ${items}
          </section>`;
      }).join('');

      const dayEvents = events.events.filter((e) => e.date === data.date).reverse();
      const timeline = `
        <section class="section">
          <h3><span>Línea de tiempo del día</span><span>${dayEvents.length} eventos</span></h3>
          <div class="timeline">${dayEvents.map((e) => `
            <div class="tl-item"><time>${fmtTime(e.at)}</time><div>${esc(eventText(e))}</div></div>`).join('') || '<p class="empty">Sin actividad este día.</p>'}
          </div>
        </section>`;

      $('#drawer-body').innerHTML = approvalBanner + actions + presence + moments + timeline;
    } catch (err) {
      $('#drawer-body').innerHTML = `<div class="error-banner">${esc(err.message)}</div>`;
    }
  }

  function eventText(e) {
    const who = e.userName ? `${e.userName}: ` : '';
    const map = {
      'item.checked': () => `${who}${e.detail?.done ? 'marcó' : 'desmarcó'} “${e.detail?.label || ''}”`,
      'photo.added': () => `${who}subió una foto · ${e.detail?.label || ''}`,
      'photo.deleted': () => `${who}eliminó una foto`,
      'moment.completed': () => `${who}completó ${e.moment === 'opening' ? 'la apertura' : e.moment === 'midday' ? 'el mediodía' : 'el cierre'}`,
      'moment.reopened': () => `Se reabrió ${e.moment === 'opening' ? 'la apertura' : e.moment}`,
      'presence.in': () => `${who}entró a la tienda`,
      'presence.out': () => `${who}salió de la tienda`,
      'approval.approved': () => `${who}aprobó la apertura`,
      'approval.rejected': () => `${who}rechazó la apertura${e.detail?.note ? `: “${e.detail.note}”` : ''}`,
      'approval.invalidated': () => 'La aprobación se invalidó por un cambio en la apertura',
    };
    return (map[e.type] || (() => e.type))();
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#backdrop').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }

  // ---------- Reportes ----------
  async function loadReport() {
    const month = $('#month').value || App.todayISO().slice(0, 7);
    try {
      const data = await api('GET', `/api/reports/openings?month=${encodeURIComponent(month)}`);
      setError('');
      $('#per-store').innerHTML = `
        <thead><tr><th>Tienda</th><th class="num">Días</th><th class="num">Abiertas</th><th class="num">A tiempo</th><th class="num">% a tiempo</th><th class="num">Aprobadas</th><th class="num">% aprobadas</th></tr></thead>
        <tbody>${data.perStore.map((s) => `
          <tr>
            <td>${esc(s.store)}</td>
            <td class="num">${s.days}</td>
            <td class="num">${s.opened}</td>
            <td class="num">${s.onTime}</td>
            <td class="num">${s.pctOnTime ?? '—'}${s.pctOnTime != null ? '%' : ''}</td>
            <td class="num">${s.approved}</td>
            <td class="num">${s.pctApproved ?? '—'}${s.pctApproved != null ? '%' : ''}</td>
          </tr>`).join('')}</tbody>`;

      $('#rows-report').innerHTML = `
        <thead><tr><th>Fecha</th><th>Tienda</th><th>Hora de apertura</th><th>Abrió</th><th>A tiempo</th><th>Estado</th><th>Aprobada por</th><th>Hora de aprobación</th><th>Primera llegada</th></tr></thead>
        <tbody>${data.rows.map((r) => `
          <tr>
            <td>${esc(r.date)}</td>
            <td>${esc(r.store)}</td>
            <td>${esc(r.openBy)}</td>
            <td>${esc(r.openedAt || '—')}</td>
            <td>${r.onTime === null ? '—' : r.onTime ? '<span class="pill complete">Sí</span>' : '<span class="pill late">No</span>'}</td>
            <td>${esc(r.status)}</td>
            <td>${r.approvedBy ? `${esc(r.approvedBy)} <span class="muted small">(${esc(r.approvedRole)})</span>` : '—'}</td>
            <td>${esc(r.approvedAt || '—')}</td>
            <td>${r.firstArrival ? `${esc(r.firstArrival)} · ${esc(r.firstArrivalBy)} <span class="muted small">${esc(r.firstArrivalMethod)}</span>` : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="9" class="empty">Sin datos para este mes.</td></tr>'}</tbody>`;
    } catch (err) {
      setError(err.message);
    }
  }

  // ---------- Tiendas (admin) ----------
  async function loadStores() {
    try {
      const [{ stores }, { users }] = await Promise.all([api('GET', '/api/stores'), api('GET', '/api/users')]);
      setError('');
      window._users = users;
      $('#store-list').innerHTML = stores.map((s) => `
        <div class="card row-card">
          <header>
            <h3>${esc(s.name)}</h3>
            <button class="btn ghost small" data-edit-store="${esc(s.id)}">Editar</button>
          </header>
          <div class="small muted">Hora de apertura: <strong>${esc(s.openBy)}</strong> · Ubicación: ${s.lat != null ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)} · radio ${s.radius} m` : '<span class="muted">sin configurar (entrada con foto)</span>'}</div>
          <div class="small">Líder: ${s.leader ? `<strong>${esc(s.leader)}</strong>` : '<span class="muted">sin asignar</span>'}</div>
          <div class="small">Baristas: ${s.baristas.length ? s.baristas.map((b) => esc(b.name)).join(', ') : '<span class="muted">sin asignar</span>'}</div>
        </div>`).join('') || '<p class="empty">No hay tiendas.</p>';
      window._stores = stores;
    } catch (err) {
      setError(err.message);
    }
  }

  function storeForm(store) {
    const users = (window._users || []).filter((u) => u.active);
    const leaders = users.filter((u) => u.role === 'leader' || u.id === store?.leaderId);
    const baristaCandidates = users.filter((u) => u.role === 'barista' || store?.baristaIds?.includes(u.id));
    const leaderOpts = leaders.map((u) =>`<option value="${esc(u.id)}" ${store?.leaderId === u.id ? 'selected' : ''}>${esc(u.name)} · ${esc(ROLE_LABEL[u.role])}</option>`).join('');
    const baristas = baristaCandidates.map((u) => `
      <label><input type="checkbox" name="baristaIds" value="${esc(u.id)}" ${store?.baristaIds?.includes(u.id) ? 'checked' : ''}> ${esc(u.name)} <span class="muted small">· ${esc(ROLE_LABEL[u.role])}</span></label>`).join('');
    return `
      <label class="field"><span>Nombre de la tienda</span><input class="input" name="name" required maxlength="60" value="${esc(store?.name || '')}"></label>
      <label class="field"><span>Hora de apertura</span><input class="input" type="time" name="openBy" required value="${esc(store?.openBy || '07:00')}"></label>
      <div class="field"><span>Ubicación de la tienda (para verificar la entrada)</span>
        <div class="controls" style="gap:8px">
          <input class="input" name="lat" inputmode="decimal" placeholder="Latitud" value="${esc(store?.lat ?? '')}" style="flex:1;min-width:120px">
          <input class="input" name="lng" inputmode="decimal" placeholder="Longitud" value="${esc(store?.lng ?? '')}" style="flex:1;min-width:120px">
        </div>
        <div class="controls" style="gap:8px;margin-top:6px">
          <button type="button" class="btn ghost small" data-use-loc>Usar mi ubicación actual</button>
          <input class="input" name="radius" type="number" min="30" max="1000" value="${esc(store?.radius ?? 150)}" style="width:110px" aria-label="Radio en metros">
          <span class="small muted">metros</span>
        </div>
        <p class="hint" style="margin-top:6px">Pon las coordenadas estando en la tienda, o pégalas desde Google Maps. Bancos y locales grandes: sube el radio.</p>
      </div>
      <label class="field"><span>Líder</span><select class="select" name="leaderId"><option value="">— sin líder —</option>${leaderOpts}</select></label>
      <div class="field"><span>Baristas</span><div class="checks">${baristas || '<span class="muted">Crea usuarios primero.</span>'}</div></div>
      <p class="hint">Cada persona solo puede estar asignada a una tienda.</p>`;
  }

  function collectStore(form) {
    const fd = new FormData(form);
    const num = (v) => (v === '' || v == null ? null : Number(v));
    return {
      name: fd.get('name'),
      openBy: fd.get('openBy'),
      lat: num(fd.get('lat')),
      lng: num(fd.get('lng')),
      radius: num(fd.get('radius')) ?? 150,
      leaderId: fd.get('leaderId') || null,
      baristaIds: fd.getAll('baristaIds'),
    };
  }

  function editStore(store) {
    const { form } = modal(store ? `Editar ${store.name}` : 'Nueva tienda', storeForm(store), async (fd, f) => {
      const body = collectStore(f);
      if (store) await api('PATCH', `/api/stores/${encodeURIComponent(store.id)}`, body);
      else await api('POST', '/api/stores', body);
      toast(store ? 'Tienda actualizada' : 'Tienda creada');
      loadStores();
    }, store ? 'Guardar cambios' : 'Crear tienda');

    form.querySelector('[data-use-loc]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Buscando…';
      const loc = await App.getLocation(15000);
      btn.disabled = false;
      btn.textContent = 'Usar mi ubicación actual';
      if (!loc) return toast('No pudimos obtener tu ubicación. Revisa el permiso del navegador o escribe las coordenadas.');
      form.lat.value = loc.lat.toFixed(6);
      form.lng.value = loc.lng.toFixed(6);
      toast(`Ubicación tomada (precisión ±${Math.round(loc.accuracy)} m)`);
    });
  }

  // ---------- Usuarios (admin) ----------
  async function loadUsers() {
    try {
      const { users } = await api('GET', '/api/users');
      setError('');
      window._users = users;
      $('#users-table').innerHTML = `
        <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Tienda</th><th>Estado</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.username)}</td>
            <td>${esc(ROLE_LABEL[u.role])}</td>
            <td>${esc(u.storeName || '—')}</td>
            <td>${u.active ? '<span class="pill complete">Activo</span>' : '<span class="pill pending">Inactivo</span>'}</td>
            <td class="num"><button class="btn ghost small" data-edit-user="${esc(u.id)}">Editar</button></td>
          </tr>`).join('')}</tbody>`;
    } catch (err) {
      setError(err.message);
    }
  }

  function userForm(user) {
    const roles = Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${user?.role === v ? 'selected' : ''}>${l}</option>`).join('');
    return `
      <label class="field"><span>Nombre</span><input class="input" name="name" required maxlength="60" value="${esc(user?.name || '')}"></label>
      ${user ? '' : `<label class="field"><span>Usuario para entrar</span><input class="input" name="username" required maxlength="30" autocapitalize="none"></label>`}
      <label class="field"><span>Rol</span><select class="select" name="role">${roles}</select></label>
      <label class="field"><span>${user ? 'Nuevo PIN (dejar vacío para no cambiar)' : 'PIN (4 a 6 números)'}</span><input class="input" name="pin" inputmode="numeric" pattern="[0-9]*" ${user ? '' : 'required'} maxlength="6"></label>
      ${user ? `<label class="field" style="grid-template-columns:auto 1fr;align-items:center"><input type="checkbox" name="active" ${user.active ? 'checked' : ''}> <span>Activo</span></label>` : ''}`;
  }

  function editUser(user) {
    modal(user ? `Editar ${user.name}` : 'Nuevo usuario', userForm(user), async (fd) => {
      if (user) {
        const body = { name: fd.get('name'), role: fd.get('role'), active: fd.get('active') === 'on' };
        if (fd.get('pin')) body.pin = fd.get('pin');
        await api('PATCH', `/api/users/${encodeURIComponent(user.id)}`, body);
      } else {
        await api('POST', '/api/users', {
          name: fd.get('name'), username: fd.get('username'), role: fd.get('role'), pin: fd.get('pin'),
        });
      }
      toast(user ? 'Usuario actualizado' : 'Usuario creado');
      loadUsers();
    }, user ? 'Guardar' : 'Crear usuario');
  }

  // ---------- Exportar ----------
  async function exportCsv() {
    const month = $('#month').value || App.todayISO().slice(0, 7);
    try {
      await App.downloadCsv(`/api/reports/openings?month=${encodeURIComponent(month)}&format=csv`, `aperturas-${month}.csv`);
    } catch (err) {
      toast(err.message);
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
    if (me.role === 'leader' || me.role === 'barista') return (location.href = '/tienda');

    config = await api('GET', '/api/config');
    statusLabel = config.statusLabel;

    $('#who').textContent = `${me.name} · ${ROLE_LABEL[me.role]}`;
    buildNav();

    const url = new URL(location.href);
    const urlDate = url.searchParams.get('date');
    $('#date').value = /^\d{4}-\d{2}-\d{2}$/.test(urlDate || '') ? urlDate : App.todayISO();
    $('#month').value = App.todayISO().slice(0, 7);

    $('#date').addEventListener('change', () => { loadToday(); });
    $('#today').addEventListener('click', () => { $('#date').value = App.todayISO(); loadToday(); });
    $('#month').addEventListener('change', loadReport);
    $('#export').addEventListener('click', exportCsv);
    $('#logout').addEventListener('click', App.signOut);
    $('#new-store')?.addEventListener('click', () => editStore(null));
    $('#new-user')?.addEventListener('click', () => editUser(null));

    $('#store-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit-store]');
      if (b) editStore(window._stores.find((s) => s.id === b.dataset.editStore));
    });
    $('#users-table').addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit-user]');
      if (b) editUser(window._users.find((u) => u.id === b.dataset.editUser));
    });

    $('#rows').addEventListener('click', (e) => {
      const approve = e.target.closest('[data-approve]');
      const reject = e.target.closest('[data-reject]');
      if (approve) return decide(approve.dataset.approve, 'approve');
      if (reject) return decide(reject.dataset.reject, 'reject');
      const row = e.target.closest('[data-store]');
      if (row) openDrawer(row.dataset.store);
    });
    $('#drawer-body').addEventListener('click', (e) => {
      const approve = e.target.closest('[data-approve]');
      const reject = e.target.closest('[data-reject]');
      if (approve) return decide(approve.dataset.approve, 'approve');
      if (reject) return decide(reject.dataset.reject, 'reject');
    });
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#backdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

    const initial = url.searchParams.get('view');
    const allowed = isAdmin() ? ['hoy', 'reportes', 'tiendas', 'usuarios'] : ['hoy', 'reportes'];
    show(allowed.includes(initial) ? initial : 'hoy');

    setInterval(() => {
      if (document.visibilityState === 'visible' && currentView === 'hoy' && $('#date').value === App.todayISO()) loadToday();
    }, 60000);
  }

  init();
})();
