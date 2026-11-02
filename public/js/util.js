// Utilidades compartidas (formato, avisos, almacenamiento local)
(function () {
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
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
    dispositivoId() {
      let id = ls.get('inv_dispositivo_id');
      if (!id) { id = uuid(); ls.set('inv_dispositivo_id', id); }
      return id;
    },
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

  U.ls = ls;
  window.U = U;
})();
