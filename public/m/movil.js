// App móvil de conteo (Firebase): login, escaneo con cámara, captura manual, teclado numérico,
// mis conteos con edición. Firestore guarda los conteos sin conexión y los envía al reconectarse.
import * as D from '/js/datos.js';

const { $, $$, esc, num, toast, hora } = U;

const st = {
  sistema: null,
  invId: null,
  inventario: null,
  catalogo: null, // índice de búsqueda
  catalogoVersion: null,
  scanner: null,
  camaraActiva: false,
  teclado: null,
  ultimoLeido: { codigo: null, t: 0 },
  mios: [],
  desuscribir: [],
};

const pref = (k, def) => { const v = U.ls.get(`inv_m_${k}`); return v == null ? def : v === '1'; };
const setPref = (k, v) => U.ls.set(`inv_m_${k}`, v ? '1' : '0');

// ---------- Vistas ----------
function mostrar(vista) {
  ['cargando', 'login', 'app'].forEach((v) => $(`#v-${v}`).classList.toggle('oculto', v !== vista));
}
function irA(pagina) {
  $('#menu').classList.add('oculto');
  $('#p-captura').classList.toggle('oculto', pagina !== 'captura');
  $('#p-mios').classList.toggle('oculto', pagina !== 'mios');
  if (pagina === 'mios') { detenerCamara(); renderMios(); }
}

// ---------- Login ----------
$('#f-login').dispositivo.value = U.ls.get('inv_dispositivo_nombre') || '';
$('#f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  const btn = f.querySelector('button');
  btn.disabled = true;
  try {
    U.ls.set('inv_dispositivo_nombre', f.dispositivo.value.trim());
    await D.entrar(f.usuario.value, f.password.value);
    f.password.value = '';
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally { btn.disabled = false; }
});

$('#b-salir').addEventListener('click', async () => {
  const pend = st.mios.filter((c) => c.pendiente).length;
  if (pend && !confirm(`Hay ${pend} conteo(s) aún sin enviar. Si cierra sesión podrían perderse. ¿Continuar?`)) return;
  detenerCamara();
  $('#menu').classList.add('oculto');
  await D.salir();
});

function limpiarSuscripciones() { st.desuscribir.forEach((f) => f()); st.desuscribir = []; }

function iniciarApp(perfil) {
  limpiarSuscripciones();
  const nombreDisp = U.ls.get('inv_dispositivo_nombre') || '';
  $('#h-usuario').textContent = `${perfil.nombre} · ${nombreDisp}`;
  mostrar('app');
  irA('captura');
  D.latido('movil', nombreDisp);
  const t = setInterval(() => D.latido('movil', nombreDisp), 60000);
  st.desuscribir.push(() => clearInterval(t));
  st.desuscribir.push(D.escucharSistema((s) => {
    st.sistema = s;
    const id = s?.inventario_activo || null;
    if (id !== st.invId) cambiarInventario(id);
  }));
}

let desInv = [];
function cambiarInventario(id) {
  desInv.forEach((f) => f()); desInv = [];
  st.invId = id; st.inventario = null; st.catalogo = null; st.catalogoVersion = null; st.mios = [];
  if (!id) { $('#h-inventario').textContent = 'Sin inventario activo'; return; }
  desInv.push(D.escucharInventario(id, async (inv) => {
    st.inventario = inv;
    $('#h-inventario').textContent = inv ? inv.nombre + (inv.estado === 'cerrado' ? ' (CERRADO)' : '') : 'Inventario no encontrado';
    if (inv && inv.catalogo_version !== st.catalogoVersion) {
      st.catalogoVersion = inv.catalogo_version;
      try {
        st.catalogo = D.indexarCatalogo(await D.cargarCatalogo(id));
        actualizarSub();
      } catch (e) { toast(`No se pudo cargar el catálogo: ${e.message}`, 'error', 4000); }
    }
  }));
  desInv.push(D.escucharMisConteos(id, (lista) => {
    st.mios = lista;
    actualizarPendientes();
    if (!$('#p-mios').classList.contains('oculto')) renderMios();
  }, (e) => console.warn(e)));
}

function actualizarSub() {
  const n = st.catalogo?.productos.length ?? 0;
  $('#h-usuario').textContent = `${D.perfil?.nombre || ''} · ${U.ls.get('inv_dispositivo_nombre') || ''} · ${num(n)} art.`;
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
  if (!window.isSecureContext) { msg.textContent = 'La cámara requiere conexión segura (https).'; return; }
  try {
    const Fm = Html5QrcodeSupportedFormats;
    st.scanner = st.scanner || new Html5Qrcode('lector', {
      verbose: false,
      formatsToSupport: [Fm.EAN_13, Fm.EAN_8, Fm.UPC_A, Fm.UPC_E, Fm.CODE_128, Fm.CODE_39, Fm.CODE_93, Fm.ITF, Fm.CODABAR, Fm.QR_CODE, Fm.DATA_MATRIX],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    });
    await st.scanner.start(
      { facingMode: 'environment' },
      { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(h, w) * 0.45) }), aspectRatio: 1.333 },
      alLeer, () => {},
    );
    st.camaraActiva = true;
    $('#lector-off').classList.add('oculto');
    $('#b-camara-off').classList.remove('oculto');
  } catch (err) {
    msg.textContent = `No se pudo abrir la cámara: ${err?.message || err}`;
  }
}
async function detenerCamara() {
  if (st.scanner && st.camaraActiva) { try { await st.scanner.stop(); } catch { /* */ } }
  st.camaraActiva = false;
  $('#lector-off').classList.remove('oculto');
  $('#b-camara-off').classList.add('oculto');
}
function pausarCamara() { try { if (st.camaraActiva) st.scanner.pause(true); } catch { /* */ } }
function reanudarCamara() { try { if (st.camaraActiva) st.scanner.resume(); } catch { /* */ } }

function alLeer(texto) {
  const t = Date.now();
  if (st.teclado) return;
  if (texto === st.ultimoLeido.codigo && t - st.ultimoLeido.t < 1500) return;
  st.ultimoLeido = { codigo: texto, t };
  procesarCodigo(texto);
}

// ---------- Captura manual + sugerencias ----------
const iCodigo = $('#i-codigo');
iCodigo.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); buscarManual(); } });
$('#b-buscar').addEventListener('click', buscarManual);
iCodigo.addEventListener('input', () => {
  const q = iCodigo.value.trim();
  const ul = $('#sugerencias');
  if (q.length < 3 || !st.catalogo) return ul.classList.add('oculto');
  const lista = st.catalogo.sugerir(q);
  ul.innerHTML = lista.map((p) => `<li data-c="${esc(p.codigo)}"><b>${esc(p.codigo)}</b>${esc(p.descripcion)}</li>`).join('');
  ul.classList.toggle('oculto', !lista.length);
});
$('#sugerencias').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-c]');
  if (!li) return;
  $('#sugerencias').classList.add('oculto'); iCodigo.value = '';
  procesarCodigo(li.dataset.c);
});
function buscarManual() {
  const c = iCodigo.value.trim();
  if (!c) return;
  $('#sugerencias').classList.add('oculto'); iCodigo.value = ''; iCodigo.blur();
  procesarCodigo(c);
}

function procesarCodigo(leido) {
  leido = String(leido).trim();
  if (!leido) return;
  if (!st.invId) { toast('No hay un inventario activo. Avise al auditor.', 'error', 3500); return; }
  if (st.inventario?.estado === 'cerrado') { toast('El inventario está cerrado', 'error', 3500); return; }
  pausarCamara();
  const p = st.catalogo?.buscar(leido) || null;
  beep(!!p);
  if ($('#op-rapido').checked && p) {
    guardarNuevo(p.codigo, leido, 1, p.descripcion);
    reanudarCamara();
    return;
  }
  abrirTeclado({ modo: 'nuevo', codigo: p ? p.codigo : leido, leido, descripcion: p?.descripcion, sinCatalogo: !st.catalogo });
}

// ---------- Teclado numérico ----------
const tValor = $('#t-valor');
function abrirTeclado(t) {
  st.teclado = t;
  $('#t-codigo').textContent = t.codigo;
  const dsc = $('#t-desc');
  if (t.descripcion) { dsc.textContent = t.descripcion; dsc.classList.remove('no-cat'); } else {
    dsc.textContent = t.sinCatalogo ? '⚠ Catálogo aún no cargado' : '⚠ Artículo no existe en el stock teórico';
    dsc.classList.add('no-cat');
  }
  tValor.textContent = t.valorInicial != null ? String(t.valorInicial) : '';
  tValor.dataset.ph = t.modo === 'nuevo' ? '1' : '0';
  $('#t-guardar').textContent = t.modo === 'editar' ? 'Actualizar' : 'Guardar';
  $('#teclado').classList.remove('oculto');
}
function cerrarTeclado() {
  st.teclado = null;
  $('#teclado').classList.add('oculto');
  st.ultimoLeido.t = Date.now();
  if (!$('#p-captura').classList.contains('oculto')) reanudarCamara();
}
function tecla(k) {
  let v = tValor.textContent;
  if (k === 'del') v = v.slice(0, -1);
  else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; } else if (v.replace('.', '').length < 9) v = v === '0' ? k : v + k;
  tValor.textContent = v;
}
$$('.teclas button').forEach((b) => b.addEventListener('click', () => tecla(b.dataset.k)));
document.addEventListener('keydown', (e) => {
  if (!st.teclado) return;
  if (/^[0-9]$/.test(e.key)) tecla(e.key);
  else if (e.key === '.' || e.key === ',') tecla('.');
  else if (e.key === 'Backspace') tecla('del');
  else if (e.key === 'Enter') $('#t-guardar').click();
  else if (e.key === 'Escape') cerrarTeclado();
  else return;
  e.preventDefault();
});
$('#t-cancelar').addEventListener('click', cerrarTeclado);
$('#t-guardar').addEventListener('click', () => {
  const t = st.teclado;
  if (!t) return;
  const txt = tValor.textContent;
  const cant = txt === '' ? Number(tValor.dataset.ph) : Number(txt);
  if (!Number.isFinite(cant) || cant < 0) return toast('Cantidad inválida', 'error');
  if (cant > 100000 && !confirm(`¿Confirma la cantidad ${num(cant)}?`)) return;
  cerrarTeclado();
  if (t.modo === 'editar') {
    D.editarConteo(st.invId, t.conteo, { cantidad: cant }).catch((e) => toast(`No se guardó la edición: ${e.message}`, 'error', 5000));
    toast('Conteo actualizado');
  } else {
    guardarNuevo(t.codigo, t.leido, cant, t.descripcion);
  }
});

function guardarNuevo(codigo, leido, cantidad, descripcion) {
  const { confirmado } = D.registrarConteo(st.invId, {
    codigo, codigo_leido: leido, cantidad, dispositivo_nombre: U.ls.get('inv_dispositivo_nombre') || '',
  });
  confirmado.catch((e) => { beep(false); toast(`No se registró ${codigo}: ${e.message}`, 'error', 6000); });
  mostrarUltimo({ codigo, cantidad, descripcion, no_catalogado: !descripcion });
  toast(`✔ ${num(cantidad)} × ${codigo}`);
}

function mostrarUltimo(r) {
  const el = $('#ultimo');
  el.classList.remove('oculto');
  el.classList.toggle('no-cat', !!r.no_catalogado);
  el.innerHTML = `<span class="cant">${esc(num(r.cantidad))}</span>
    <div class="muted">Último registro</div>
    <div><b>${esc(r.codigo)}</b> ${esc(r.descripcion || 'No catalogado')}</div>`;
}

function actualizarPendientes() {
  const n = st.mios.filter((c) => c.pendiente).length;
  const el = $('#h-pendientes');
  el.textContent = `${n} sin enviar`;
  el.classList.toggle('oculto', n === 0);
}

// ---------- Mis conteos ----------
function renderMios() {
  const lista = st.mios;
  const piezas = lista.reduce((a, c) => a + c.cantidad, 0);
  $('#mios-totales').innerHTML = `
    <div><b>${num(lista.length)}</b><span>registros</span></div>
    <div><b>${num(new Set(lista.map((c) => c.codigo)).size)}</b><span>artículos</span></div>
    <div><b>${num(Math.round(piezas * 1000) / 1000)}</b><span>piezas</span></div>`;
  const cerrado = st.inventario?.estado === 'cerrado';
  const desc = (c) => st.catalogo?.buscar(c.codigo)?.descripcion || 'No catalogado';
  $('#mios-lista').innerHTML = lista.length ? lista.map((c) => `
    <li class="${c.pendiente ? 'pend' : ''}" data-id="${esc(c.id)}">
      <div class="info">
        <div class="desc">${esc(desc(c))}</div>
        <div class="meta">${esc(c.codigo)} · ${hora(c.creado)}${c.pendiente ? ' · <b>sin enviar</b>' : ''}${c.modificado ? ' · editado' : ''}</div>
      </div>
      <div class="cant">${esc(num(c.cantidad))}</div>
      ${cerrado ? '' : '<button class="chico">Editar</button>'}
    </li>`).join('') : '<p class="muted">Aún no tiene conteos en este inventario.</p>';
}
$('#mios-lista').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const c = st.mios.find((x) => x.id === b.closest('li').dataset.id);
  if (c) abrirTeclado({ modo: 'editar', conteo: c, codigo: c.codigo, descripcion: st.catalogo?.buscar(c.codigo)?.descripcion, valorInicial: c.cantidad });
});

// ---------- Arranque ----------
(async () => {
  try { await D.iniciar(); } catch (e) { $('#v-cargando').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  D.alCambiarSesion((perfil, err) => {
    if (perfil) iniciarApp(perfil);
    else {
      limpiarSuscripciones(); cambiarInventario(null);
      mostrar('login');
      if (err) $('#login-error').textContent = err.message;
    }
  });
})();
