(() => {
  const form = document.getElementById('login-form');
  const err = document.getElementById('login-error');

  // Si ya hay sesión válida, ir directo a su pantalla
  async function redirectIfSignedIn() {
    if (!App.token()) return;
    try {
      const { user } = await App.api('GET', '/api/me');
      location.replace(user.role === 'leader' || user.role === 'barista' ? '/tienda' : '/');
    } catch {
      App.setToken(null);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value, pin: form.pin.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo entrar');
      App.setToken(data.token);
      location.replace(data.user.role === 'leader' || data.user.role === 'barista' ? '/tienda' : '/');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      form.pin.value = '';
      form.pin.focus();
    } finally {
      btn.disabled = false;
    }
  });

  redirectIfSignedIn();
})();
