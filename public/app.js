// Utilidades compartidas por todas las pantallas.
window.App = (() => {
  const TOKEN_KEY = 'coffee-ops:token';
  const TZ = 'America/Lima';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };

  const token = () => store.get(TOKEN_KEY);
  const setToken = (t) => store.set(TOKEN_KEY, t || null);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function headers(extra = {}) {
    const t = token();
    return t ? { Authorization: `Bearer ${t}`, ...extra } : extra;
  }

  async function api(method, url, body) {
    const opts = { method, headers: headers() };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers = headers({ 'Content-Type': 'application/json' });
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) {
      setToken(null);
      location.href = '/login';
      throw new Error('Sesión expirada');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  // Ubicación del dispositivo. Devuelve null si el usuario la niega o no está disponible.
  function getLocation(timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
      );
    });
  }

  async function downloadCsv(url, filename) {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error('No se pudo exportar');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function todayISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    });
  }

  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // Modal sencillo con formulario
  function modal(title, bodyHtml, onSubmit, submitLabel = 'Guardar') {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop open';
    wrap.innerHTML = `
      <form class="modal card" novalidate>
        <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost small" data-close>Cerrar</button></div>
        <div class="modal-body">${bodyHtml}</div>
        <p class="error-inline" hidden></p>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-close>Cancelar</button>
          <button type="submit" class="btn">${esc(submitLabel)}</button>
        </div>
      </form>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
    const form = wrap.querySelector('form');
    const err = wrap.querySelector('.error-inline');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        await onSubmit(new FormData(form), form);
        close();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 30);
    return { close, form };
  }

  function signOut() {
    api('POST', '/api/logout').catch(() => {}).finally(() => {
      setToken(null);
      location.href = '/login';
    });
  }

  return { api, downloadCsv, getLocation, esc, todayISO, fmtDate, toast, modal, token, setToken, signOut, store };
})();
