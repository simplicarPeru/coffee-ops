(() => {
  const $ = (sel) => document.querySelector(sel);
  const { api, esc, toast } = App;

  const ICON = { complete: '✓', in_progress: '…', late: '!', incomplete: '!', pending: '' };
  const STATE_LABEL = { complete: 'Completo', in_progress: 'En curso', late: 'Atrasado', incomplete: 'Incompleto', pending: 'Pendiente' };
  const MOMENT_ORDER = ['opening', 'midday', 'closing'];

  let me = null;
  let store = null;
  let data = null;
  let activeMoment = null;
  const busy = new Set();

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' }) : '');

  function currentMomentKey() {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (hour < 12) return 'opening';
    if (hour < 18) return 'midday';
    return 'closing';
  }

  // Reduce la foto antes de subirla (más rápido con datos móviles). Si falla, sube el original.
  async function shrinkImage(file, maxSide = 1600, quality = 0.82) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      return blob ? new File([blob], 'foto.jpg', { type: 'image/jpeg' }) : file;
    } catch {
      return file;
    }
  }

  async function load() {
    try {
      data = await api('GET', `/api/stores/${encodeURIComponent(store.id)}/checks`);
      $('#error').hidden = true;
      render();
    } catch (err) {
      $('#error').hidden = false;
      $('#error').textContent = `Sin conexión o error: ${err.message}. Se reintentará.`;
    }
  }

  function render() {
    if (!data) return;
    $('#store-name').textContent = data.name;
    $('#store-date').textContent = App.fmtDate(data.date);

    renderApproval();
    renderPresence();

    $('#tabs').innerHTML = MOMENT_ORDER.map((k) => {
      const mm = data.moments[k];
      return `
        <button class="tab ${k === activeMoment ? 'active' : ''}" data-moment="${k}" role="tab" aria-selected="${k === activeMoment}">
          <div class="t">${esc(mm.label)}</div>
          <div class="s">${ICON[mm.state] ? ICON[mm.state] + ' ' : ''}${mm.done}/${mm.total}</div>
        </button>`;
    }).join('');

    const m = data.moments[activeMoment];
    const pct = m.total ? Math.round((m.done / m.total) * 100) : 0;
    $('#summary').innerHTML = `
      <div class="summary-row">
        <strong>${esc(m.label)}</strong>
        <span class="pill ${m.state}">${STATE_LABEL[m.state]}</span>
      </div>
      <div class="progress ${m.state}"><span style="width:${pct}%"></span></div>
      <p class="small muted" style="margin:8px 0 0">
        ${m.done === m.total ? 'Todo listo para este momento. ¡Gracias!' : `Faltan ${m.total - m.done} punto(s) · límite ${m.deadline}`}
      </p>`;

    $('#checklist').innerHTML = data.moments[activeMoment].items.map(taskHtml).join('');
  }

  function renderApproval() {
    const box = $('#approval-banner');
    if (data.status === 'approved') {
      box.innerHTML = `<div class="banner ok">Tienda abierta y aprobada por ${esc(data.approval.byName)} a las ${fmtTime(data.approval.at)}</div>`;
    } else if (data.status === 'rejected') {
      box.innerHTML = `<div class="banner bad"><strong>Apertura rechazada</strong> por ${esc(data.approval.byName)}${data.approval.note ? `: “${esc(data.approval.note)}”` : ''}. Corrige lo que falta y vuelve a completarla.</div>`;
    } else if (data.status === 'awaiting') {
      box.innerHTML = '<div class="banner warn">Apertura completa. Esperando la aprobación del gerente.</div>';
    } else {
      box.innerHTML = '';
    }
  }

  let needEntryPhoto = false;

  function renderPresence() {
    const mine = data.presence.members.find((m) => m.id === me.id);
    const inside = !!mine?.present;
    const sending = busy.has('presence');
    $('#presence-title').textContent = inside
      ? `Estás dentro desde ${mine.since} (${mine.method === 'foto' ? 'con foto' : 'por ubicación'})`
      : 'Aún no has entrado hoy';
    $('#presence-sub').textContent = `${data.presence.present} de ${data.presence.total} del equipo dentro`;
    $('#btn-in').disabled = inside || sending;
    $('#btn-in').textContent = sending ? 'Verificando…' : 'Entrar';
    $('#btn-out').disabled = !inside || sending;

    const photoBox = $('#entry-photo-box');
    photoBox.hidden = !needEntryPhoto || inside;
    photoBox.innerHTML = needEntryPhoto && !inside
      ? `<p class="small muted" style="margin:0 0 8px;width:100%">No pudimos confirmar que estás en la tienda. Toma una foto de la entrada (con la cámara) para registrarla.</p>
         <label class="camera-btn ${sending ? 'busy' : ''}">📷 Foto de entrada<input type="file" accept="image/*" capture="environment" id="entry-photo" ${sending ? 'disabled' : ''}></label>`
      : '';
    // El input de foto se reconstruye al renderizar; su listener está en el contenedor
    $('#roster').innerHTML = data.presence.members.map((m) => `
      <span class="chip ${m.present ? 'in' : ''}">${esc(m.name)} <span class="role">${m.role === 'leader' ? 'líder' : 'barista'}${m.present ? ` · ${m.since} · ${m.method === 'foto' ? 'foto' : 'ubicación'}` : ''}</span></span>`).join('');
  }

  function taskHtml(item) {
    const photos = item.photos.map((p) => `
      <div class="thumb">
        <img src="${esc(p.url)}" alt="Foto" loading="lazy">
        <button type="button" data-delete-photo="${esc(p.id)}" aria-label="Eliminar foto">×</button>
      </div>`).join('');

    const control = item.type === 'check'
      ? `<button class="check-btn ${item.done ? 'on' : ''}" data-toggle="${esc(item.id)}" aria-pressed="${item.done}">${item.done ? '✓ Hecho' : 'Marcar'}</button>`
      : '';

    const isBusy = busy.has(item.id);
    const photoControl = `
      <div class="photo-action">
        <label class="camera-btn ${isBusy ? 'busy' : ''}">
          📷 ${isBusy ? 'Subiendo…' : item.photos.length ? 'Otra foto' : 'Tomar foto'}
          <input type="file" accept="image/*" capture="environment" data-photo="${esc(item.id)}" ${isBusy ? 'disabled' : ''}>
        </label>
        <div class="thumbs">${photos}</div>
      </div>`;

    return `
      <article class="task ${item.done ? 'done' : ''}" data-item="${esc(item.id)}">
        <div class="task-top">
          <div class="task-label">${esc(item.label)}</div>
          ${control}
        </div>
        ${item.type === 'photo' || item.photos.length ? photoControl : ''}
      </article>`;
  }

  function findItem(itemId) {
    return data?.moments[activeMoment]?.items.find((i) => i.id === itemId);
  }

  async function toggle(itemId) {
    const item = findItem(itemId);
    if (!item) return;
    try {
      await api('PUT', `/api/stores/${encodeURIComponent(store.id)}/items/${activeMoment}/${encodeURIComponent(itemId)}`, {
        date: data.date, done: !item.done,
      });
      await load();
    } catch (err) {
      toast(`No se guardó: ${err.message}`);
    }
  }

  async function uploadPhoto(itemId, file) {
    if (!file) return;
    busy.add(itemId);
    render();
    try {
      const small = await shrinkImage(file);
      const form = new FormData();
      form.append('photo', small, small.name || 'foto.jpg');
      form.append('date', data.date);
      await api('POST', `/api/stores/${encodeURIComponent(store.id)}/photos/${activeMoment}/${encodeURIComponent(itemId)}`, form);
      toast('Foto guardada');
    } catch (err) {
      toast(`No se pudo subir la foto: ${err.message}. Intenta de nuevo.`);
    } finally {
      busy.delete(itemId);
      await load();
    }
  }

  async function deletePhoto(photoId) {
    if (!confirm('¿Eliminar esta foto?')) return;
    try {
      await api('DELETE', `/api/stores/${encodeURIComponent(store.id)}/photos/${activeMoment}/${encodeURIComponent(photoId)}?date=${data.date}`);
      toast('Foto eliminada');
      await load();
    } catch (err) {
      toast(`No se pudo eliminar: ${err.message}`);
    }
  }

  // Entrada: verifica ubicación. Si no está dentro del radio de la tienda, pide foto de la entrada.
  async function checkIn(photoFile) {
    busy.add('presence');
    render();
    try {
      const loc = await App.getLocation();
      const form = new FormData();
      form.append('type', 'in');
      if (loc) {
        form.append('lat', loc.lat);
        form.append('lng', loc.lng);
        form.append('accuracy', loc.accuracy);
      }
      if (photoFile) form.append('photo', await shrinkImage(photoFile), 'entrada.jpg');
      const res = await api('POST', `/api/stores/${encodeURIComponent(store.id)}/presence`, form);
      needEntryPhoto = false;
      toast(res.method === 'ubicación' ? 'Entrada registrada por ubicación' : 'Entrada registrada con foto');
    } catch (err) {
      if (err.data?.code === 'NEED_PHOTO') {
        needEntryPhoto = true;
        toast(err.message);
      } else {
        toast(err.message);
      }
    } finally {
      busy.delete('presence');
      await load();
    }
  }

  async function checkOut() {
    try {
      await api('POST', `/api/stores/${encodeURIComponent(store.id)}/presence`, { type: 'out' });
      toast('Salida registrada');
      await load();
    } catch (err) {
      toast(err.message);
    }
  }

  async function init() {
    if (!App.token()) return (location.href = '/login');
    try {
      const res = await api('GET', '/api/me');
      me = res.user;
      store = res.store;
    } catch {
      return;
    }
    $('#who-name').textContent = me.name;
    $('#logout').addEventListener('click', App.signOut);

    if (!store) {
      $('#not-store').hidden = false;
      if (me.role === 'leader' || me.role === 'barista') $('#not-store p').textContent = 'Tu usuario todavía no está asignado a una tienda. Pide al administrador que te asigne.';
      return;
    }

    $('#app').hidden = false;
    activeMoment = currentMomentKey();

    $('#tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-moment]');
      if (!btn) return;
      activeMoment = btn.dataset.moment;
      render();
    });
    $('#checklist').addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle]');
      if (t) return toggle(t.dataset.toggle);
      const d = e.target.closest('[data-delete-photo]');
      if (d) return deletePhoto(d.dataset.deletePhoto);
    });
    $('#checklist').addEventListener('change', (e) => {
      const input = e.target.closest('input[data-photo]');
      if (!input) return;
      const file = input.files?.[0];
      input.value = '';
      uploadPhoto(input.dataset.photo, file);
    });
    $('#btn-in').addEventListener('click', () => checkIn(null));
    $('#btn-out').addEventListener('click', checkOut);
    document.addEventListener('change', (e) => {
      if (e.target.id !== 'entry-photo') return;
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) checkIn(file);
    });

    await load();
    setInterval(() => {
      if (document.visibilityState === 'visible' && busy.size === 0) load();
    }, 45000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') load();
    });
  }

  init();
})();
