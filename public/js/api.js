// Cliente de API compartido entre la app móvil y el panel de PC
(function () {
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  const API = {
    ls,
    ApiError,
    prefijo: 'inv',
    get token() { return ls.get(`${this.prefijo}_token`); },
    set token(v) { ls.set(`${this.prefijo}_token`, v); },
    get usuario() { try { return JSON.parse(ls.get(`${this.prefijo}_usuario`)); } catch { return null; } },
    set usuario(v) { ls.set(`${this.prefijo}_usuario`, v ? JSON.stringify(v) : null); },

    dispositivoId() {
      let id = ls.get('inv_dispositivo_id');
      if (!id) { id = uuid(); ls.set('inv_dispositivo_id', id); }
      return id;
    },

    alExpirar: null, // callback cuando la sesión deja de ser válida

    async req(metodo, url, cuerpo, { blob = false } = {}) {
      const opts = { method: metodo, headers: {} };
      if (this.token) opts.headers.Authorization = `Bearer ${this.token}`;
      if (cuerpo instanceof FormData) opts.body = cuerpo;
      else if (cuerpo !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(cuerpo); }
      const res = await fetch(`/api${url}`, opts); // un error de red lanza TypeError
      if (!res.ok) {
        let msg = `Error ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch { /* sin cuerpo JSON */ }
        if (res.status === 401 && this.alExpirar && !url.startsWith('/auth/login')) this.alExpirar();
        throw new ApiError(res.status, msg);
      }
      return blob ? res.blob() : res.json();
    },
    get(u) { return this.req('GET', u); },
    post(u, b) { return this.req('POST', u, b ?? {}); },
    put(u, b) { return this.req('PUT', u, b ?? {}); },
    del(u) { return this.req('DELETE', u); },

    async descargar(url, nombre) {
      const b = await this.req('GET', url, undefined, { blob: true });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = nombre;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
  };

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  // Utilidades de formato
  const nf = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 3 });
  const mf = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const U = {
    uuid,
    num: (n) => (n == null || n === '' ? '' : nf.format(n)),
    dinero: (n) => (n == null ? '' : mf.format(n)),
    fecha: (iso) => (iso ? new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'medium' }) : ''),
    hora: (iso) => (iso ? new Date(iso).toLocaleTimeString('es-MX') : ''),
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    $: (sel, el = document) => el.querySelector(sel),
    $$: (sel, el = document) => [...el.querySelectorAll(sel)],
    toast(msg, tipo = 'ok', ms = 2200) {
      let c = document.getElementById('toasts');
      if (!c) { c = document.createElement('div'); c.id = 'toasts'; document.body.appendChild(c); }
      const t = document.createElement('div');
      t.className = `toast toast-${tipo}`;
      t.textContent = msg;
      c.appendChild(t);
      while (c.children.length > 2) c.firstChild.remove();
      setTimeout(() => t.remove(), ms);
    },
  };

  window.API = API;
  window.U = U;
})();
