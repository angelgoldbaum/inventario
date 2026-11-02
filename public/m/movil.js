// App móvil de conteo: login, escaneo con cámara, captura manual, teclado numérico,
// mis conteos (con edición) y cola sin conexión.
(function () {
  const { $, $$, esc, num, toast, hora } = U;
  API.prefijo = 'inv_m';

  const estado = {
    inventario: null,
    scanner: null,
    camaraActiva: false,
    teclado: null, // { modo: 'nuevo'|'editar', codigo, descripcion, conteoId, valorInicial }
    ultimoLeido: { codigo: null, t: 0 },
  };

  // ---------- Preferencias ----------
  const pref = (k, def) => { const v = API.ls.get(`inv_m_${k}`); return v == null ? def : v === '1'; };
  const setPref = (k, v) => API.ls.set(`inv_m_${k}`, v ? '1' : '0');

  // ---------- Vistas ----------
  function mostrar(vista) {
    $('#v-login').classList.toggle('oculto', vista !== 'login');
    $('#v-app').classList.toggle('oculto', vista !== 'app');
  }
  function irA(pagina) {
    $('#menu').classList.add('oculto');
    $('#p-captura').classList.toggle('oculto', pagina !== 'captura');
    $('#p-mios').classList.toggle('oculto', pagina !== 'mios');
    if (pagina === 'mios') { detenerCamara(); cargarMios(); }
  }

  // ---------- Login ----------
  $('#f-login').dispositivo.value = API.ls.get('inv_dispositivo_nombre') || '';
  $('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#login-error').textContent = '';
    try {
      API.ls.set('inv_dispositivo_nombre', f.dispositivo.value.trim());
      const r = await API.post('/auth/login', {
        usuario: f.usuario.value.trim(), password: f.password.value, tipo: 'movil',
        dispositivo_id: API.dispositivoId(), dispositivo_nombre: f.dispositivo.value.trim(),
      });
      API.token = r.token;
      API.usuario = r.usuario;
      f.password.value = '';
      await iniciarApp();
    } catch (err) {
      $('#login-error').textContent = err instanceof API.ApiError ? err.message : 'No hay conexión con el servidor';
    }
  });

  API.alExpirar = () => { detenerCamara(); API.token = null; mostrar('login'); toast('La sesión expiró, vuelva a entrar', 'warn'); };

  $('#b-salir').addEventListener('click', async () => {
    if (cola().length && !confirm(`Hay ${cola().length} conteo(s) sin enviar. Si cierra sesión se conservarán en este dispositivo. ¿Continuar?`)) return;
    try { await API.post('/auth/logout'); } catch { /* sin conexión */ }
    detenerCamara();
    API.token = null; API.usuario = null;
    $('#menu').classList.add('oculto');
    mostrar('login');
  });

  async function iniciarApp() {
    const u = API.usuario;
    $('#h-usuario').textContent = `${u?.nombre || ''} · ${API.ls.get('inv_dispositivo_nombre') || ''}`;
    try {
      estado.inventario = await API.get('/inventarios/activo');
      $('#h-inventario').textContent = estado.inventario.nombre + (estado.inventario.estado === 'cerrado' ? ' (CERRADO)' : '');
    } catch (err) {
      if (err instanceof API.ApiError && err.status === 401) return;
      $('#h-inventario').textContent = err instanceof API.ApiError ? err.message : 'Sin conexión';
    }
    mostrar('app');
    irA('captura');
    actualizarPendientes();
    enviarCola();
  }

  // ---------- Menú / opciones ----------
  $('#b-menu').addEventListener('click', () => $('#menu').classList.toggle('oculto'));
  $$('#menu [data-ir]').forEach((b) => b.addEventListener('click', () => irA(b.dataset.ir)));
  $('#op-rapido').checked = pref('rapido', false);
  $('#op-sonido').checked = pref('sonido', true);
  $('#op-rapido').addEventListener('change', (e) => setPref('rapido', e.target.checked));
  $('#op-sonido').addEventListener('change', (e) => setPref('sonido', e.target.checked));

  // ---------- Retroalimentación ----------
  let audioCtx;
  function beep(ok = true) {
    if (!$('#op-sonido').checked) return;
    try {
      navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.frequency.value = ok ? 1400 : 380; g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + (ok ? 0.08 : 0.25));
    } catch { /* sin audio */ }
  }

  // ---------- Cámara ----------
  $('#b-camara').addEventListener('click', iniciarCamara);
  $('#b-camara-off').addEventListener('click', detenerCamara);

  async function iniciarCamara() {
    const msg = $('#camara-msg');
    msg.textContent = '';
    if (!window.isSecureContext) {
      msg.textContent = 'La cámara requiere conexión segura (https). Abra la dirección https:// que muestra el servidor.';
      return;
    }
    try {
      const F = Html5QrcodeSupportedFormats;
      estado.scanner = estado.scanner || new Html5Qrcode('lector', {
        verbose: false,
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      });
      await estado.scanner.start(
        { facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.45) }), aspectRatio: 1.333 },
        alLeer,
        () => {},
      );
      estado.camaraActiva = true;
      $('#lector-off').classList.add('oculto');
      $('#b-camara-off').classList.remove('oculto');
    } catch (err) {
      msg.textContent = `No se pudo abrir la cámara: ${err?.message || err}`;
    }
  }

  async function detenerCamara() {
    if (estado.scanner && estado.camaraActiva) {
      try { await estado.scanner.stop(); } catch { /* ya detenida */ }
    }
    estado.camaraActiva = false;
    $('#lector-off').classList.remove('oculto');
    $('#b-camara-off').classList.add('oculto');
  }

  function pausarCamara() { try { if (estado.camaraActiva) estado.scanner.pause(true); } catch { /* */ } }
  function reanudarCamara() { try { if (estado.camaraActiva) estado.scanner.resume(); } catch { /* */ } }

  function alLeer(texto) {
    const ahora = Date.now();
    if (estado.teclado) return;
    // evita lecturas repetidas del mismo código inmediatamente después de guardar
    if (texto === estado.ultimoLeido.codigo && ahora - estado.ultimoLeido.t < 1500) return;
    estado.ultimoLeido = { codigo: texto, t: ahora };
    procesarCodigo(texto);
  }

  // ---------- Captura manual + sugerencias ----------
  const iCodigo = $('#i-codigo');
  let tSug;
  iCodigo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarManual(); } });
  $('#b-buscar').addEventListener('click', buscarManual);
  iCodigo.addEventListener('input', () => {
    clearTimeout(tSug);
    const q = iCodigo.value.trim();
    if (q.length < 3) return ocultarSug();
    tSug = setTimeout(async () => {
      try {
        const lista = await API.get(`/productos/sugerir?q=${encodeURIComponent(q)}`);
        if (iCodigo.value.trim() !== q) return;
        const ul = $('#sugerencias');
        ul.innerHTML = lista.map((p) => `<li data-c="${esc(p.codigo)}"><b>${esc(p.codigo)}</b>${esc(p.descripcion)}</li>`).join('');
        ul.classList.toggle('oculto', !lista.length);
      } catch { /* sin conexión */ }
    }, 250);
  });
  $('#sugerencias').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-c]');
    if (!li) return;
    ocultarSug(); iCodigo.value = '';
    procesarCodigo(li.dataset.c);
  });
  function ocultarSug() { $('#sugerencias').classList.add('oculto'); }
  function buscarManual() {
    const c = iCodigo.value.trim();
    if (!c) return;
    ocultarSug(); iCodigo.value = ''; iCodigo.blur();
    procesarCodigo(c);
  }

  async function procesarCodigo(codigo) {
    codigo = String(codigo).trim();
    if (!codigo) return;
    pausarCamara();
    let info = { encontrado: false, codigo, descripcion: null, sinConexion: false };
    try {
      info = await API.get(`/productos/buscar?codigo=${encodeURIComponent(codigo)}`);
    } catch (err) {
      if (err instanceof API.ApiError) { toast(err.message, 'error', 3500); reanudarCamara(); return; }
      info.sinConexion = true;
    }
    beep(info.encontrado);
    if ($('#op-rapido').checked && info.encontrado) {
      await guardarNuevo(info.codigo, 1, info.descripcion);
      reanudarCamara();
      return;
    }
    abrirTeclado({ modo: 'nuevo', codigo: info.encontrado ? info.codigo : codigo, descripcion: info.descripcion, encontrado: info.encontrado, sinConexion: info.sinConexion });
  }

  // ---------- Teclado numérico ----------
  const tValor = $('#t-valor');
  function abrirTeclado(t) {
    estado.teclado = t;
    $('#t-codigo').textContent = t.codigo;
    const d = $('#t-desc');
    if (t.descripcion) { d.textContent = t.descripcion; d.classList.remove('no-cat'); }
    else { d.textContent = t.sinConexion ? '⚠ Sin conexión: se registrará y enviará después' : '⚠ Artículo no existe en el stock teórico'; d.classList.add('no-cat'); }
    tValor.textContent = t.valorInicial != null ? String(t.valorInicial) : '';
    tValor.dataset.ph = t.modo === 'nuevo' ? '1' : '0';
    $('#t-guardar').textContent = t.modo === 'editar' ? 'Actualizar' : 'Guardar';
    $('#teclado').classList.remove('oculto');
  }
  function cerrarTeclado() {
    estado.teclado = null;
    $('#teclado').classList.add('oculto');
    estado.ultimoLeido.t = Date.now();
    if (!$('#p-captura').classList.contains('oculto')) reanudarCamara();
  }
  function tecla(k) {
    let v = tValor.textContent;
    if (k === 'del') v = v.slice(0, -1);
    else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
    else if (v.replace('.', '').length < 9) v = v === '0' ? k : v + k;
    tValor.textContent = v;
  }
  $$('.teclas button').forEach((b) => b.addEventListener('click', () => tecla(b.dataset.k)));
  document.addEventListener('keydown', (e) => {
    if (!estado.teclado) return;
    if (/^[0-9]$/.test(e.key)) tecla(e.key);
    else if (e.key === '.' || e.key === ',') tecla('.');
    else if (e.key === 'Backspace') tecla('del');
    else if (e.key === 'Enter') $('#t-guardar').click();
    else if (e.key === 'Escape') cerrarTeclado();
    else return;
    e.preventDefault();
  });
  $('#t-cancelar').addEventListener('click', cerrarTeclado);
  $('#t-guardar').addEventListener('click', async () => {
    const t = estado.teclado;
    if (!t) return;
    const txt = tValor.textContent;
    const cant = txt === '' ? Number(tValor.dataset.ph) : Number(txt);
    if (!Number.isFinite(cant) || cant < 0) return toast('Cantidad inválida', 'error');
    if (cant > 100000 && !confirm(`¿Confirma la cantidad ${num(cant)}?`)) return;
    $('#t-guardar').disabled = true;
    try {
      if (t.modo === 'editar') {
        if (t.pendiente) {
          const c = cola(); const it = c.find((x) => x.client_uuid === t.conteoId);
          if (it) { it.cantidad = cant; guardarCola(c); }
        } else {
          await API.put(`/conteos/${t.conteoId}`, { cantidad: cant });
        }
        toast('Conteo actualizado');
        cerrarTeclado();
        cargarMios();
      } else {
        cerrarTeclado();
        await guardarNuevo(t.codigo, cant, t.descripcion);
      }
    } catch (err) {
      toast(err.message || 'Error', 'error', 3500);
    } finally {
      $('#t-guardar').disabled = false;
    }
  });

  async function guardarNuevo(codigo, cantidad, descripcion) {
    const reg = { codigo, cantidad, client_uuid: U.uuid(), creado: new Date().toISOString(), descripcion };
    try {
      const r = await API.post('/conteos', { codigo, cantidad, client_uuid: reg.client_uuid });
      mostrarUltimo({ ...reg, descripcion: r.descripcion, no_catalogado: r.no_catalogado });
      toast(`✔ ${num(cantidad)} × ${codigo}`);
    } catch (err) {
      if (err instanceof API.ApiError) { toast(err.message, 'error', 4000); beep(false); return; }
      // sin conexión: guarda en cola local
      const c = cola(); c.push(reg); guardarCola(c);
      mostrarUltimo({ ...reg, pendiente: true });
      toast('Sin conexión: guardado en el dispositivo', 'warn', 3000);
    }
  }

  function mostrarUltimo(r) {
    const el = $('#ultimo');
    el.classList.remove('oculto');
    el.classList.toggle('no-cat', !!(r.no_catalogado || r.pendiente));
    el.innerHTML = `<span class="cant">${esc(num(r.cantidad))}</span>
      <div class="muted">Último registro ${r.pendiente ? '(pendiente de envío)' : ''}</div>
      <div><b>${esc(r.codigo)}</b> ${esc(r.descripcion || (r.no_catalogado ? 'No catalogado' : ''))}</div>`;
  }

  // ---------- Cola sin conexión ----------
  const COLA = 'inv_m_cola';
  function cola() { try { return JSON.parse(API.ls.get(COLA)) || []; } catch { return []; } }
  function guardarCola(c) { API.ls.set(COLA, JSON.stringify(c)); actualizarPendientes(); }
  function actualizarPendientes() {
    const n = cola().length;
    const el = $('#h-pendientes');
    el.textContent = `${n} sin enviar`;
    el.classList.toggle('oculto', n === 0);
  }
  let enviando = false;
  async function enviarCola() {
    if (enviando || !API.token) return;
    const c = cola();
    if (!c.length) return;
    enviando = true;
    try {
      for (const reg of c) {
        try {
          await API.post('/conteos', { codigo: reg.codigo, cantidad: reg.cantidad, client_uuid: reg.client_uuid });
          guardarCola(cola().filter((x) => x.client_uuid !== reg.client_uuid));
        } catch (err) {
          if (err instanceof API.ApiError && err.status !== 401) {
            // error de validación/inventario cerrado: se descarta con aviso para no bloquear la cola
            toast(`No se pudo enviar ${reg.codigo}: ${err.message}`, 'error', 5000);
            guardarCola(cola().filter((x) => x.client_uuid !== reg.client_uuid));
          } else break;
        }
      }
      if (!cola().length) toast('Conteos pendientes enviados');
    } finally { enviando = false; }
  }
  setInterval(enviarCola, 10000);
  window.addEventListener('online', enviarCola);

  // ---------- Mis conteos ----------
  async function cargarMios() {
    const pend = cola();
    let datos = { totales: { registros: 0, piezas: 0, articulos: 0 }, conteos: [], inventario: estado.inventario };
    try { datos = await API.get('/conteos/mios'); } catch (err) { if (!(err instanceof API.ApiError)) toast('Sin conexión: mostrando sólo pendientes', 'warn'); }
    const cerrado = datos.inventario?.estado === 'cerrado';
    $('#mios-totales').innerHTML = `
      <div><b>${num(datos.totales.registros)}</b><span>registros</span></div>
      <div><b>${num(datos.totales.articulos)}</b><span>artículos</span></div>
      <div><b>${num(datos.totales.piezas)}</b><span>piezas</span></div>`;
    const items = [
      ...pend.map((p) => ({ ...p, id: p.client_uuid, pendiente: true })).reverse(),
      ...datos.conteos,
    ];
    $('#mios-lista').innerHTML = items.length ? items.map((c) => `
      <li class="${c.pendiente ? 'pend' : ''}" data-id="${esc(c.id)}" data-pend="${c.pendiente ? 1 : ''}">
        <div class="info">
          <div class="desc">${esc(c.descripcion || 'No catalogado')}</div>
          <div class="meta">${esc(c.codigo)} · ${hora(c.creado)}${c.pendiente ? ' · <b>sin enviar</b>' : ''}${c.modificado ? ' · editado' : ''}</div>
        </div>
        <div class="cant">${esc(num(c.cantidad))}</div>
        ${cerrado && !c.pendiente ? '' : '<button class="chico">Editar</button>'}
      </li>`).join('') : '<p class="muted">Aún no tiene conteos en este inventario.</p>';
    $('#mios-lista').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const li = b.closest('li');
      const it = items.find((x) => String(x.id) === li.dataset.id);
      abrirTeclado({ modo: 'editar', conteoId: it.id, pendiente: !!li.dataset.pend, codigo: it.codigo, descripcion: it.descripcion, valorInicial: it.cantidad });
    };
  }

  // ---------- Arranque ----------
  if (API.token) {
    API.get('/auth/yo').then((r) => { API.usuario = r.usuario; iniciarApp(); })
      .catch((err) => {
        if (err instanceof API.ApiError) mostrar('login');
        else iniciarApp(); // sin conexión: permite seguir capturando en cola
      });
  } else mostrar('login');
})();
