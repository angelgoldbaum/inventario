// Panel de PC (Firebase): inventarios/stock, concentrado de conteos en vivo, revisión, reportes, usuarios y bitácora
import * as D from '/js/datos.js';
import { leerArchivoStock, descargarPlantilla, exportarXlsx } from '/js/stock.js';
import { calcularRevision, recalcular, resumen, r4 } from '/js/revision.js';

const { $, $$, esc, num, dinero, fecha, toast } = U;

const st = {
  perfil: null,
  sistema: null,
  inventarios: [],
  invId: null,
  tab: null,
  catalogo: [], catalogoVersion: null,
  conteos: [], cNuevos: new Set(), cPagina: 0,
  correcciones: new Map(),
  rev: null, rFiltradas: [], rPagina: 0, rOrden: [{ k: 'dif_costo', dir: 1 }], rFiltrosCol: {},
  subs: [], subsInv: [],
};
const POR_PAGINA = 200;
const inv = () => st.inventarios.find((i) => i.id === st.invId);
const esAdmin = () => st.perfil?.rol === 'admin';

// ================= Modal genérico =================
function modal({ titulo, html, ok = 'Guardar', cancelar = 'Cancelar', alAceptar, ancho }) {
  const fondo = document.createElement('div');
  fondo.className = 'modal-fondo';
  fondo.innerHTML = `<form class="modal" ${ancho ? `style="max-width:${ancho}px"` : ''}><h3>${esc(titulo)}</h3><div class="cuerpo">${html}</div>
    <div class="error"></div>
    <div class="acciones">${cancelar ? `<button type="button" data-x>${esc(cancelar)}</button>` : ''}${ok ? `<button class="primario" type="submit">${esc(ok)}</button>` : ''}</div></form>`;
  document.body.appendChild(fondo);
  const form = fondo.querySelector('form');
  const cerrar = () => fondo.remove();
  fondo.querySelector('[data-x]')?.addEventListener('click', cerrar);
  fondo.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrar(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!alAceptar) return cerrar();
    const b = form.querySelector('button[type=submit]');
    b.disabled = true;
    try { if ((await alAceptar(form)) !== false) cerrar(); } catch (err) { form.querySelector('.error').textContent = err.message; } finally { b.disabled = false; }
  });
  setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 30);
  return { form, cerrar };
}

// ================= Vistas / sesión =================
function mostrar(v) { ['cargando', 'setup', 'login', 'app'].forEach((x) => $(`#v-${x}`).classList.toggle('oculto', x !== v)); }

$('#f-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#setup-error').textContent = '';
  f.querySelector('button').disabled = true;
  try {
    await D.configurarSistema({ empresa: f.empresa.value.trim(), nombre: f.nombre.value.trim(), usuario: f.usuario.value.trim(), password: f.password.value });
    location.reload();
  } catch (err) { $('#setup-error').textContent = err.message; f.querySelector('button').disabled = false; }
});

$('#f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    const p = await D.entrar(f.usuario.value, f.password.value);
    if (p.rol === 'contador') { await D.salir(); $('#login-error').textContent = 'El panel de PC es sólo para auditores y administradores'; return; }
    f.password.value = '';
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#b-salir').addEventListener('click', () => D.salir());
$('#b-pass').addEventListener('click', () => modal({
  titulo: 'Cambiar contraseña',
  html: '<label>Contraseña actual</label><input name="actual" type="password" required><label>Nueva contraseña (mín. 6)</label><input name="nueva" type="password" minlength="6" required><label>Confirmar</label><input name="conf" type="password" required>',
  async alAceptar(f) {
    if (f.nueva.value !== f.conf.value) throw new Error('Las contraseñas no coinciden');
    await D.cambiarMiPassword(f.actual.value, f.nueva.value);
    toast('Contraseña actualizada');
  },
}));

function limpiar(arr) { arr.forEach((f) => f()); arr.length = 0; }

function iniciarPanel(perfil) {
  st.perfil = perfil;
  $('#h-usuario').textContent = `${perfil.nombre} (${perfil.rol})`;
  $('#cfg-empresa').classList.toggle('oculto', !esAdmin());
  $('#b-nuevo-usuario').classList.toggle('oculto', !esAdmin());
  mostrar('app');
  D.latido('pc', 'PC');
  const t = setInterval(() => D.latido('pc', 'PC'), 60000);
  st.subs.push(() => clearInterval(t));
  st.subs.push(D.escucharSistema((s) => {
    st.sistema = s;
    $('#h-empresa').textContent = s?.empresa || 'Inventarios';
    if (document.activeElement !== $('#i-empresa')) $('#i-empresa').value = s?.empresa || '';
    renderInventarios();
  }));
  st.subs.push(D.escucharInventarios((lista) => {
    st.inventarios = lista;
    if (!lista.some((i) => i.id === st.invId)) {
      const guardado = U.ls.get('inv_pc_inv');
      const id = (lista.find((i) => i.id === guardado) || lista.find((i) => i.id === st.sistema?.inventario_activo) || lista[0])?.id ?? null;
      seleccionarInventario(id);
    }
    renderInventarios();
    const i = inv();
    if (i && i.catalogo_version !== st.catalogoVersion) cargarCatalogo();
  }));
  irTab(U.ls.get('inv_pc_tab') || 'revision');
}

// ================= Inventario seleccionado (suscripciones en vivo) =================
function seleccionarInventario(id) {
  limpiar(st.subsInv);
  st.invId = id;
  st.catalogo = []; st.catalogoVersion = null; st.conteos = []; st.correcciones = new Map(); st.rev = null;
  st.cPagina = 0; st.rPagina = 0;
  if (!id) { programarRecalculo(); return; }
  U.ls.set('inv_pc_inv', id);
  cargarCatalogo();
  let primera = true;
  st.subsInv.push(D.escucharConteos(id, (lista, agregados) => {
    st.conteos = lista;
    st.cNuevos = primera ? new Set() : new Set(agregados);
    primera = false;
    programarRecalculo();
  }, (e) => toast(`Conteos: ${e.message}`, 'error')));
  st.subsInv.push(D.escucharCorrecciones(id, (m) => { st.correcciones = m; programarRecalculo(); }, (e) => toast(`Correcciones: ${e.message}`, 'error')));
}

async function cargarCatalogo() {
  const i = inv();
  if (!i) return;
  st.catalogoVersion = i.catalogo_version;
  try { st.catalogo = await D.cargarCatalogo(i.id); } catch (e) { toast(`Catálogo: ${e.message}`, 'error'); }
  programarRecalculo();
}

let tRecalc;
function programarRecalculo() {
  clearTimeout(tRecalc);
  tRecalc = setTimeout(() => {
    st.rev = { filas: calcularRevision(st.catalogo, st.conteos, st.correcciones) };
    st.porCodigo = new Map(st.catalogo.map((p) => [p.codigo, p]));
    if (st.tab === 'revision') renderRevision();
    if (st.tab === 'conteos') renderConteos();
    if (st.tab === 'reportes') prepararReportes();
  }, 150);
}

$('#sel-inventario').addEventListener('change', (e) => { seleccionarInventario(e.target.value); renderInventarios(); irTab(st.tab); });

$$('#pestanas button').forEach((b) => b.addEventListener('click', () => irTab(b.dataset.tab)));
function irTab(tab) {
  st.tab = tab;
  U.ls.set('inv_pc_tab', tab);
  $$('#pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === tab));
  $$('.tab').forEach((t) => t.classList.toggle('oculto', t.id !== `tab-${tab}`));
  ({ conteos: renderConteos, revision: () => { renderEncabezado(); renderRevision(); }, reportes: prepararReportes, usuarios: cargarUsuarios, bitacora: cargarBitacora })[tab]?.();
}

// ================= INVENTARIOS Y STOCK =================
function renderInventarios() {
  const activo = st.sistema?.inventario_activo;
  $('#sel-inventario').innerHTML = st.inventarios.map((i) => `<option value="${esc(i.id)}" ${i.id === st.invId ? 'selected' : ''}>${esc(i.nombre)}${i.id === activo ? ' ★' : ''}</option>`).join('');
  const i = inv();
  const e = $('#h-estado');
  e.textContent = i ? (i.estado === 'cerrado' ? 'CERRADO' : (i.id === activo ? 'ACTIVO (celulares)' : 'abierto')) : '';
  e.className = `etiqueta ${i?.estado === 'cerrado' ? 'e-faltante' : (i?.id === activo ? 'e-ok' : 'e-info')}`;
  $('#stock-destino').textContent = i ? i.nombre : '—';
  $('#inv-lista').innerHTML = st.inventarios.map((x) => `<tr>
    <td><b>${esc(x.nombre)}</b>${x.id === activo ? ' <span class="etiqueta e-ok">activo</span>' : ''}</td>
    <td><span class="etiqueta ${x.estado === 'cerrado' ? 'e-faltante' : 'e-info'}">${x.estado}</span></td>
    <td class="n">${num(x.productos || 0)}</td><td class="n">${x.id === st.invId ? num(st.conteos.filter((c) => !c.eliminado).length) : ''}</td>
    <td>${x.stock_cargado ? `${esc(fecha(x.stock_cargado))}<br><span class="muted">${esc(x.stock_archivo || '')}</span>` : '<span class="muted">—</span>'}</td>
    <td class="acc">
      ${x.id === activo ? '' : `<button class="chico" data-act="activar" data-id="${esc(x.id)}">Activar</button>`}
      <button class="chico" data-act="${x.estado === 'cerrado' ? 'reabrir' : 'cerrar'}" data-id="${esc(x.id)}">${x.estado === 'cerrado' ? 'Reabrir' : 'Cerrar'}</button>
      <button class="chico" data-act="renombrar" data-id="${esc(x.id)}">Renombrar</button>
      ${esAdmin() && x.id !== activo ? `<button class="chico peligro" data-act="eliminar" data-id="${esc(x.id)}">Eliminar</button>` : ''}
    </td></tr>`).join('');
}
$('#inv-lista').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const x = st.inventarios.find((i) => i.id === b.dataset.id);
  try {
    switch (b.dataset.act) {
      case 'activar': await D.activarInventario(x.id); toast('Inventario activado para los celulares'); break;
      case 'cerrar': if (!confirm(`¿Cerrar "${x.nombre}"? Ya no se podrán capturar ni modificar conteos.`)) return; await D.actualizarInventario(x.id, { estado: 'cerrado' }); break;
      case 'reabrir': await D.actualizarInventario(x.id, { estado: 'abierto' }); break;
      case 'renombrar': { const n = prompt('Nuevo nombre', x.nombre); if (!n) return; await D.actualizarInventario(x.id, { nombre: n }); break; }
      case 'eliminar':
        if (!confirm(`¿Eliminar DEFINITIVAMENTE "${x.nombre}" con su stock, conteos y correcciones?`)) return;
        b.disabled = true; b.textContent = 'Eliminando…';
        await D.eliminarInventario(x.id); toast('Inventario eliminado'); break;
    }
  } catch (err) { toast(err.message, 'error', 4000); }
});
$('#b-nuevo-inv').addEventListener('click', () => modal({
  titulo: 'Nuevo inventario',
  html: '<label>Nombre</label><input name="nombre" required placeholder="Ej. Sucursal Centro - Nov 2026"><label>Notas</label><textarea name="notas" rows="2"></textarea><label class="check" style="margin-top:12px"><input type="checkbox" name="activar" checked style="width:auto"> Activarlo para los celulares</label>',
  async alAceptar(f) {
    const id = await D.crearInventario(f.nombre.value.trim(), f.notas.value, f.activar.checked);
    seleccionarInventario(id);
    toast('Inventario creado. Ahora cargue el stock teórico.');
  },
}));

$('#f-stock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const i = inv();
  if (!i) return;
  const archivo = f.archivo.files[0];
  if (!archivo) return;
  if (f.modo.value === 'reemplazar' && i.productos > 0 && !confirm(`Se reemplazará el stock teórico de "${i.nombre}" (${i.productos} artículos). Los conteos no se borran. ¿Continuar?`)) return;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Cargando…';
  const out = $('#stock-resultado');
  try {
    const r = await leerArchivoStock(archivo);
    const total = await D.guardarCatalogo(i.id, r.productos, archivo.name, f.modo.value);
    out.innerHTML = `<div class="resultado"><b>✔ ${num(r.productos.length)} artículos leídos</b> (${f.modo.value}); el inventario tiene ${num(total)} artículos${r.alternos ? `, ${num(r.alternos)} códigos alternos` : ''}.
      ${r.advertencias.length ? `<div>${r.advertencias.length} advertencia(s):</div><ul>${r.advertencias.slice(0, 200).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div>`;
    f.archivo.value = '';
  } catch (err) {
    out.innerHTML = `<div class="resultado error">${esc(err.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'Cargar'; }
});
$('#b-plantilla').addEventListener('click', descargarPlantilla);

// ================= CONTEOS (concentrado en vivo) =================
const descDe = (codigo) => st.porCodigo?.get(codigo)?.descripcion ?? null;
function llenarSelect(sel, opciones, todos) {
  const s = $(sel); const v = s.value;
  s.innerHTML = `<option value="">${todos}</option>` + opciones.sort((a, b) => String(a.t).localeCompare(String(b.t))).map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('');
  s.value = v;
}
function conteosFiltrados() {
  const q = $('#c-buscar').value.trim().toLowerCase();
  const u = $('#c-usuario').value; const dsp = $('#c-dispositivo').value;
  const elim = $('#c-eliminados').checked;
  return st.conteos.filter((c) => (elim || !c.eliminado)
    && (!q || c.codigo.toLowerCase().includes(q) || (descDe(c.codigo) || '').toLowerCase().includes(q) || (c.codigo_leido || '').toLowerCase().includes(q))
    && (!u || c.usuario_id === u) && (!dsp || (c.dispositivo_nombre || '(sin nombre)') === dsp))
    .sort((a, b) => String(b.creado).localeCompare(String(a.creado)));
}
function renderConteos() {
  if (st.tab !== 'conteos') return;
  llenarSelect('#c-usuario', [...new Map(st.conteos.map((c) => [c.usuario_id, c.usuario_nombre]))].map(([v, t]) => ({ v, t })), 'Todos los contadores');
  llenarSelect('#c-dispositivo', [...new Set(st.conteos.map((c) => c.dispositivo_nombre || '(sin nombre)'))].map((v) => ({ v, t: v })), 'Todos los dispositivos');
  const lista = conteosFiltrados();
  const activos = lista.filter((c) => !c.eliminado);
  $('#c-resumen').textContent = `${num(activos.length)} registros · ${num(new Set(activos.map((c) => c.codigo)).size)} artículos · ${num(r4(activos.reduce((a, c) => a + c.cantidad, 0)))} piezas`;
  const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
  st.cPagina = Math.min(st.cPagina, paginas - 1);
  const cerrado = inv()?.estado === 'cerrado';
  $('#t-conteos tbody').innerHTML = lista.slice(st.cPagina * POR_PAGINA, (st.cPagina + 1) * POR_PAGINA).map((c, n) => {
    const dsc = descDe(c.codigo);
    return `<tr class="${c.eliminado ? 'eliminado' : ''} ${st.cNuevos.has(c.id) ? 'nuevo' : ''}">
      <td class="muted">${lista.length - (st.cPagina * POR_PAGINA + n)}</td><td>${esc(fecha(c.creado))}${c.pendiente ? ' <span class="etiqueta e-sobrante">enviando</span>' : ''}</td>
      <td><a class="codigo" data-cod="${esc(c.codigo)}">${esc(c.codigo)}</a>${c.codigo_leido && c.codigo_leido !== c.codigo ? `<br><span class="muted">leído: ${esc(c.codigo_leido)}</span>` : ''}</td>
      <td class="desc">${dsc == null ? '<span class="etiqueta e-no_catalogado">no catalogado</span>' : esc(dsc)}</td>
      <td class="n"><b>${num(c.cantidad)}</b></td><td>${esc(c.usuario_nombre)}</td><td>${esc(c.dispositivo_nombre || '')}</td>
      <td>${c.origen === 'auditor' ? '<span class="etiqueta e-info">auditor</span>' : 'móvil'}</td>
      <td>${c.modificado ? `${esc(fecha(c.modificado))}<br><span class="muted">${esc(c.modificado_por_nombre || '')}</span>` : ''}</td>
      <td class="acc">${c.eliminado || cerrado ? '' : `<button class="chico" data-ed="${esc(c.id)}">Editar</button><button class="chico peligro" data-del="${esc(c.id)}">Eliminar</button>`}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="muted">Sin conteos</td></tr>';
  paginacion('#c-pag', st.cPagina, paginas, lista.length, (p) => { st.cPagina = p; renderConteos(); });
}
['#c-buscar', '#c-usuario', '#c-dispositivo', '#c-eliminados'].forEach((s) => $(s).addEventListener('input', () => { st.cPagina = 0; renderConteos(); }));
$('#t-conteos').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-cod]'); if (a) return detalleArticulo(a.dataset.cod);
  const ed = e.target.closest('[data-ed]'); if (ed) return editarConteo(st.conteos.find((c) => c.id === ed.dataset.ed));
  const del = e.target.closest('[data-del]'); if (del) return eliminarConteo(st.conteos.find((c) => c.id === del.dataset.del));
});
$('#c-agregar').addEventListener('click', () => agregarConteo(null));
$('#c-excel').addEventListener('click', () => exportar('conteos'));

function editarConteo(c, despues) {
  modal({
    titulo: 'Editar conteo',
    html: `<p class="muted">Capturado por <b>${esc(c.usuario_nombre)}</b> en ${esc(c.dispositivo_nombre || '?')} — ${esc(fecha(c.creado))}</p>
      <label>Código</label><input name="codigo" value="${esc(c.codigo)}" required>
      <label>Cantidad</label><input name="cantidad" type="number" step="any" min="0" value="${c.cantidad}" required>`,
    async alAceptar(f) {
      const cambios = { cantidad: Number(f.cantidad.value) };
      const cod = f.codigo.value.trim();
      if (cod && cod !== c.codigo) {
        const p = st.porCodigo.get(cod) || st.catalogo.find((x) => x.alternos?.includes(cod));
        cambios.codigo = p ? p.codigo : cod; cambios.codigo_leido = cod;
      }
      await D.editarConteo(st.invId, c, cambios);
      toast('Conteo actualizado'); despues?.();
    },
  });
}
async function eliminarConteo(c, despues) {
  if (!confirm(`¿Eliminar el conteo ${c.codigo} × ${num(c.cantidad)} de ${c.usuario_nombre}?`)) return;
  try { await D.editarConteo(st.invId, c, { eliminado: true }); toast('Conteo eliminado'); despues?.(); } catch (err) { toast(err.message, 'error'); }
}
async function agregarConteo(codigo, despues) {
  let usuarios = [];
  try { usuarios = await D.listarUsuarios(); } catch { /* */ }
  const { form: f } = modal({
    titulo: 'Agregar conteo (auditor)',
    html: `<label>Código</label><input name="codigo" value="${esc(codigo || '')}" required><div class="muted" id="m-desc"></div>
      <label>Cantidad</label><input name="cantidad" type="number" step="any" min="0" required>
      <label>Registrar a nombre de</label><select name="usuario_id">${usuarios.filter((u) => u.activo).map((u) => `<option value="${esc(u.uid)}" ${u.uid === st.perfil.uid ? 'selected' : ''}>${esc(u.nombre)} (${u.rol})</option>`).join('')}</select>`,
    async alAceptar(fm) {
      const leido = fm.codigo.value.trim();
      const p = st.porCodigo.get(leido) || st.catalogo.find((x) => x.alternos?.includes(leido));
      const u = usuarios.find((x) => x.uid === fm.usuario_id.value) || st.perfil;
      const { confirmado } = D.registrarConteo(st.invId, {
        codigo: p ? p.codigo : leido, codigo_leido: leido, cantidad: Number(fm.cantidad.value), origen: 'auditor',
        usuario_id: u.uid, usuario_nombre: u.nombre, dispositivo_nombre: 'PC (auditor)',
      });
      await confirmado;
      D.bitacora(st.invId, 'conteo_agregar_auditor', p ? p.codigo : leido, { cantidad: Number(fm.cantidad.value), a_nombre_de: u.nombre }).catch(() => {});
      toast(p ? 'Conteo agregado' : 'Conteo agregado (código no catalogado)', p ? 'ok' : 'warn');
      despues?.();
    },
  });
  const buscar = () => {
    const k = f.codigo.value.trim();
    const p = st.porCodigo.get(k) || st.catalogo.find((x) => x.alternos?.includes(k));
    f.querySelector('#m-desc').textContent = k ? (p ? p.descripcion : '⚠ No existe en el stock teórico') : '';
  };
  f.codigo.addEventListener('input', buscar);
  if (codigo) { buscar(); setTimeout(() => f.cantidad.focus(), 50); }
}

// Detalle de un artículo: todos sus conteos con edición
function detalleArticulo(codigo) {
  const lista = st.conteos.filter((c) => c.codigo === codigo).sort((a, b) => String(a.creado).localeCompare(String(b.creado)));
  const fila = st.rev?.filas.find((x) => x.codigo === codigo);
  const cerrado = inv()?.estado === 'cerrado';
  const m = modal({
    titulo: `${codigo} — ${fila?.descripcion || 'No catalogado'}`,
    ancho: 860, ok: null, cancelar: 'Cerrar',
    html: `${fila ? `<div class="kpis"><div class="kpi"><span>Teórico</span><b>${num(fila.teorico)}</b></div><div class="kpi"><span>Contado</span><b>${num(fila.contado ?? 0)}</b></div>
        <div class="kpi"><span>Corrección</span><b>${fila.correccion != null ? num(fila.correccion) : '—'}</b></div><div class="kpi"><span>Diferencia</span><b class="${fila.diferencia < 0 ? 'neg' : fila.diferencia > 0 ? 'pos' : ''}">${num(fila.diferencia)}</b></div>
        <div class="kpi"><span>Dif. $ costo</span><b>${dinero(fila.dif_costo)}</b></div></div>` : ''}
      <table class="tabla"><thead><tr><th>Fecha</th><th class="n">Cantidad</th><th>Contador</th><th>Dispositivo</th><th>Leído</th><th></th></tr></thead><tbody>
      ${lista.map((c) => `<tr class="${c.eliminado ? 'eliminado' : ''}"><td>${esc(fecha(c.creado))}</td><td class="n"><b>${num(c.cantidad)}</b></td><td>${esc(c.usuario_nombre)}</td><td>${esc(c.dispositivo_nombre || '')}</td><td>${esc(c.codigo_leido || '')}</td>
        <td class="acc">${c.eliminado || cerrado ? '' : `<button type="button" class="chico" data-ed="${esc(c.id)}">Editar</button><button type="button" class="chico peligro" data-del="${esc(c.id)}">Eliminar</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin conteos</td></tr>'}
      </tbody></table>
      ${cerrado ? '' : '<div style="margin-top:10px"><button type="button" class="primario" data-add>+ Agregar conteo a este artículo</button></div>'}`,
  });
  const refrescar = () => { m.cerrar(); setTimeout(() => detalleArticulo(codigo), 300); };
  m.form.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-ed]'); if (ed) editarConteo(lista.find((c) => c.id === ed.dataset.ed), refrescar);
    const del = e.target.closest('[data-del]'); if (del) eliminarConteo(lista.find((c) => c.id === del.dataset.del), refrescar);
    if (e.target.closest('[data-add]')) agregarConteo(codigo, refrescar);
  });
}

// ================= REVISIÓN =================
const COLS = [
  { k: 'codigo', t: 'Código', tipo: 'txt' },
  { k: 'descripcion', t: 'Descripción', tipo: 'txt' },
  { k: 'categoria', t: 'Categoría', tipo: 'txt', opcional: true },
  { k: 'costo', t: 'Costo', tipo: 'num', fmt: dinero },
  { k: 'precio_vta', t: 'P. venta', tipo: 'num', fmt: dinero },
  { k: 'teorico', t: 'Teórico', tipo: 'num' },
  { k: 'contado', t: 'Contado', tipo: 'num' },
  { k: 'correccion', t: 'Corrección', tipo: 'num', editable: true },
  { k: 'final', t: 'Final', tipo: 'num' },
  { k: 'diferencia', t: 'Dif. pzas', tipo: 'num', signo: true },
  { k: 'dif_costo', t: 'Dif. $ costo', tipo: 'num', fmt: dinero, signo: true },
  { k: 'dif_venta', t: 'Dif. $ venta', tipo: 'num', fmt: dinero, signo: true },
  { k: 'estado', t: 'Estado', tipo: 'txt' },
  { k: 'registros', t: 'Reg.', tipo: 'num' },
  { k: 'contadores', t: 'Contadores', tipo: 'txt' },
];
const ESTADOS = { ok: 'OK', faltante: 'Faltante', sobrante: 'Sobrante', no_catalogado: 'No catalogado' };
let colsVisibles = COLS;
let hayCategorias = null;

function renderKpis() {
  const s = resumen(st.rev.filas);
  const avance = s.articulos ? (100 * s.contados / s.articulos).toFixed(1) : '0';
  $('#r-kpis').innerHTML = `
    <div class="kpi"><span>Artículos</span><b>${num(s.articulos)}</b> <small>${s.no_catalogados ? `${s.no_catalogados} no catalogados` : ''}</small></div>
    <div class="kpi"><span>Avance de conteo</span><b>${avance}%</b> <small>${num(s.contados)} contados · ${num(s.sin_contar)} sin contar</small></div>
    <div class="kpi"><span>Con diferencia</span><b>${num(s.con_diferencia)}</b> <small>${num(s.faltantes)} falt. · ${num(s.sobrantes)} sobr. · ${num(s.corregidos)} corr.</small></div>
    <div class="kpi"><span>Piezas teórico → físico</span><b>${num(r4(s.piezas_teorico))} → ${num(r4(s.piezas_final))}</b> <small>${num(r4(s.piezas_faltantes))} / +${num(r4(s.piezas_sobrantes))}</small></div>
    <div class="kpi"><span>Valor teórico / físico (costo)</span><b>${dinero(s.valor_teorico)}</b> <small>${dinero(s.valor_final)}</small></div>
    <div class="kpi"><span>Faltante / sobrante (costo)</span><b class="neg">${dinero(s.costo_faltante)}</b> <small class="pos">+${dinero(s.costo_sobrante)}</small></div>
    <div class="kpi"><span>Diferencia neta costo</span><b class="${s.costo_neto < 0 ? 'neg' : s.costo_neto > 0 ? 'pos' : ''}">${dinero(s.costo_neto)}</b></div>
    <div class="kpi"><span>Diferencia neta venta</span><b class="${s.venta_neta < 0 ? 'neg' : s.venta_neta > 0 ? 'pos' : ''}">${dinero(s.venta_neta)}</b></div>`;
}

function renderEncabezado() {
  const flecha = (k) => { const i = st.rOrden.findIndex((o) => o.k === k); if (i < 0) return ''; return ` <span class="flecha">${st.rOrden[i].dir > 0 ? '▲' : '▼'}${st.rOrden.length > 1 ? i + 1 : ''}</span>`; };
  $('#t-revision thead').innerHTML = `<tr>${colsVisibles.map((c) => `<th class="ord ${c.tipo === 'num' ? 'n' : ''}" data-k="${c.k}">${c.t}${flecha(c.k)}</th>`).join('')}</tr>
    <tr class="filtros">${colsVisibles.map((c) => `<th><input data-fk="${c.k}" value="${esc(st.rFiltrosCol[c.k] || '')}" placeholder="${c.tipo === 'num' ? '>0' : 'filtrar'}"></th>`).join('')}</tr>`;
}
$('#t-revision thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.ord'); if (!th) return;
  const k = th.dataset.k;
  const i = st.rOrden.findIndex((o) => o.k === k);
  if (e.shiftKey) { if (i >= 0) st.rOrden[i].dir *= -1; else st.rOrden.push({ k, dir: 1 }); } else st.rOrden = [{ k, dir: i === 0 && st.rOrden.length === 1 ? -st.rOrden[0].dir : 1 }];
  renderEncabezado(); renderRevision();
});
let tFiltro;
$('#t-revision thead').addEventListener('input', (e) => {
  const k = e.target.dataset.fk; if (!k) return;
  st.rFiltrosCol[k] = e.target.value;
  clearTimeout(tFiltro); tFiltro = setTimeout(() => { st.rPagina = 0; renderRevision(); }, 200);
});

// Filtro numérico: >5, <0, >=1, <=2, =0, !=0, 10..20, o número exacto
function coincideNum(v, expr) {
  expr = expr.replace(/\s/g, '').replace(',', '.');
  if (!expr) return true;
  if (v == null || v === '') return expr === 'vacio' || expr === '-';
  let m = expr.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/);
  if (m) return v >= Number(m[1]) && v <= Number(m[2]);
  m = expr.match(/^(>=|<=|!=|<>|>|<|=)?(-?[\d.]+)$/);
  if (!m) return String(v).includes(expr);
  const n = Number(m[2]);
  switch (m[1]) { case '>': return v > n; case '<': return v < n; case '>=': return v >= n; case '<=': return v <= n; case '!=': case '<>': return v !== n; default: return v === n; }
}

function filtrarRevision() {
  if (!st.rev) return [];
  const q = $('#r-buscar').value.trim().toLowerCase();
  const est = $('#r-estado').value;
  const cat = $('#r-categoria').value;
  const filtrosCol = Object.entries(st.rFiltrosCol).filter(([, v]) => v.trim());
  const tipos = Object.fromEntries(COLS.map((c) => [c.k, c.tipo]));
  const filas = st.rev.filas.filter((f) => {
    if (q && !f.codigo.toLowerCase().includes(q) && !(f.descripcion || '').toLowerCase().includes(q)) return false;
    if (cat && f.categoria !== cat) return false;
    switch (est) {
      case 'dif': if (!f.diferencia) return false; break;
      case 'sin_contar': if (!f.sin_contar) return false; break;
      case 'contados': if (f.sin_contar) return false; break;
      case 'corregidos': if (f.correccion == null) return false; break;
      case '': break;
      default: if (f.estado !== est) return false;
    }
    for (const [k, v] of filtrosCol) {
      if (tipos[k] === 'num') { if (!coincideNum(f[k], v)) return false; } else {
        const val = k === 'estado' ? ESTADOS[f.estado] : f[k];
        if (!String(val ?? '').toLowerCase().includes(v.trim().toLowerCase())) return false;
      }
    }
    return true;
  });
  return filas.sort((a, b) => {
    for (const { k, dir } of st.rOrden) {
      const x = a[k]; const y = b[k];
      if (x == null && y == null) continue;
      if (x == null) return 1; if (y == null) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true });
      if (r) return r * dir;
    }
    return 0;
  });
}

function celda(c, f) {
  const v = f[c.k];
  if (c.editable) return `<td class="n"><input class="corr ${v != null ? 'con-valor' : ''}" data-cod="${esc(f.codigo)}" value="${v ?? ''}" inputmode="decimal" ${inv()?.estado === 'cerrado' ? 'disabled' : ''} title="${f.correccion_usuario ? `Corregido por ${esc(f.correccion_usuario)} ${esc(fecha(f.correccion_fecha))}` : 'Cantidad correcta'}"></td>`;
  if (c.k === 'codigo') return `<td><a class="codigo" data-cod="${esc(f.codigo)}">${esc(f.codigo)}</a></td>`;
  if (c.k === 'descripcion') return `<td class="desc">${f.no_catalogado ? '<i class="muted">(no catalogado)</i>' : esc(v)}</td>`;
  if (c.k === 'estado') return `<td><span class="etiqueta e-${f.estado}">${ESTADOS[f.estado]}</span>${f.sin_contar && !f.no_catalogado ? ' <span class="etiqueta e-info">sin contar</span>' : ''}</td>`;
  if (c.k === 'contadores') return `<td class="muted">${esc(v || '')}</td>`;
  if (c.tipo === 'num') {
    const cls = c.signo ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : '';
    const txt = v == null ? '' : (c.fmt ? c.fmt(v) : num(v));
    return `<td class="n ${cls}">${c.signo && v > 0 ? '+' : ''}${txt}</td>`;
  }
  return `<td>${esc(v ?? '')}</td>`;
}

function renderRevision() {
  if (st.tab !== 'revision' || !st.rev) return;
  const cats = [...new Set(st.rev.filas.map((f) => f.categoria).filter(Boolean))].sort();
  if (hayCategorias !== cats.length > 0) {
    hayCategorias = cats.length > 0;
    colsVisibles = COLS.filter((c) => !c.opcional || hayCategorias);
    renderEncabezado();
  }
  const sc = $('#r-categoria'); const v = sc.value;
  sc.innerHTML = '<option value="">Todas las categorías</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  sc.value = v; sc.classList.toggle('oculto', !cats.length);

  // conserva el foco y lo escrito en la celda de corrección si llega una actualización en vivo
  const act = document.activeElement?.classList.contains('corr') ? { cod: document.activeElement.dataset.cod, val: document.activeElement.value, sucio: document.activeElement.dataset.sucio } : null;

  renderKpis();
  st.rFiltradas = filtrarRevision();
  const paginas = Math.max(1, Math.ceil(st.rFiltradas.length / POR_PAGINA));
  st.rPagina = Math.min(st.rPagina, paginas - 1);
  const pag = st.rFiltradas.slice(st.rPagina * POR_PAGINA, (st.rPagina + 1) * POR_PAGINA);
  $('#t-revision tbody').innerHTML = pag.map((f) => `<tr data-cod="${esc(f.codigo)}">${colsVisibles.map((c) => celda(c, f)).join('')}</tr>`).join('')
    || `<tr><td colspan="${colsVisibles.length}" class="muted">${st.rev.filas.length ? 'Ningún artículo coincide con los filtros' : 'Cargue el stock teórico y/o capture conteos'}</td></tr>`;
  renderPie();
  paginacion('#r-pag', st.rPagina, paginas, st.rFiltradas.length, (p) => { st.rPagina = p; renderRevision(); });

  if (act) {
    const inp = $(`#t-revision input.corr[data-cod="${CSS.escape(act.cod)}"]`);
    if (inp) {
      ignorarBlur = true;
      if (act.sucio) { inp.value = act.val; inp.dataset.sucio = '1'; }
      inp.focus();
      ignorarBlur = false;
    }
  }
}

function renderPie() {
  const Fs = st.rFiltradas;
  const sum = (k) => Fs.reduce((a, f) => a + (f[k] || 0), 0);
  $('#t-revision tfoot').innerHTML = `<tr>${colsVisibles.map((c, i) => {
    if (i === 0) return `<td>${num(Fs.length)} art.</td>`;
    if (['teorico', 'contado', 'final', 'diferencia', 'registros'].includes(c.k)) return `<td class="n">${num(r4(sum(c.k)))}</td>`;
    if (['dif_costo', 'dif_venta'].includes(c.k)) return `<td class="n">${dinero(sum(c.k))}</td>`;
    return '<td></td>';
  }).join('')}</tr>`;
}

let ignorarBlur = false;
async function guardarCorreccion(inp) {
  const f = st.rev.filas.find((x) => x.codigo === inp.dataset.cod);
  if (!f) return;
  delete inp.dataset.sucio;
  const txt = inp.value.trim().replace(',', '.');
  const nuevo = txt === '' ? null : Number(txt);
  if (nuevo !== null && (!Number.isFinite(nuevo) || nuevo < 0)) { toast('Cantidad inválida', 'error'); inp.value = f.correccion ?? ''; return; }
  if (nuevo === f.correccion) return;
  const antes = f.correccion;
  f.correccion = nuevo; recalcular(f); // actualización inmediata; la confirmación llega por el listener
  inp.classList.toggle('con-valor', nuevo != null);
  try { await D.fijarCorreccion(st.invId, f.codigo, nuevo, antes); } catch (err) { toast(err.message, 'error'); f.correccion = antes; recalcular(f); programarRecalculo(); }
}
const tbodyRev = $('#t-revision tbody');
tbodyRev.addEventListener('input', (e) => { if (e.target.matches('input.corr')) e.target.dataset.sucio = '1'; });
tbodyRev.addEventListener('keydown', (e) => {
  const inp = e.target.closest('input.corr'); if (!inp) return;
  if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const todos = $$('input.corr', tbodyRev);
    const sig = todos[todos.indexOf(inp) + (e.key === 'ArrowUp' ? -1 : 1)];
    if (sig) { sig.focus(); sig.select(); } else inp.blur();
  } else if (e.key === 'Escape') {
    const f = st.rev.filas.find((x) => x.codigo === inp.dataset.cod); inp.value = f.correccion ?? ''; delete inp.dataset.sucio; inp.blur();
  }
});
tbodyRev.addEventListener('focusout', (e) => { if (!ignorarBlur && e.target.matches('input.corr') && e.target.dataset.sucio) guardarCorreccion(e.target); });
tbodyRev.addEventListener('focusin', (e) => { if (e.target.matches('input.corr') && !ignorarBlur) e.target.select(); });
tbodyRev.addEventListener('click', (e) => { const a = e.target.closest('a[data-cod]'); if (a) detalleArticulo(a.dataset.cod); });

['#r-buscar', '#r-estado', '#r-categoria'].forEach((s) => $(s).addEventListener('input', () => { st.rPagina = 0; renderRevision(); }));
$('#r-limpiar').addEventListener('click', () => { $('#r-buscar').value = ''; $('#r-estado').value = ''; $('#r-categoria').value = ''; st.rFiltrosCol = {}; renderEncabezado(); renderRevision(); });
$('#r-excel').addEventListener('click', () => exportar('revision'));
$('#r-ticket').addEventListener('click', () => {
  if (!st.rev) return;
  const filtros = [$('#r-estado').selectedOptions[0].text, $('#r-buscar').value && `"${$('#r-buscar').value}"`, $('#r-categoria').value].filter(Boolean).join(' · ');
  imprimirReporte(Reportes.lista.find((r) => r.id === 'dif-ticket'), st.rFiltradas, `Filtro: ${filtros}`);
});

// ================= REPORTES =================
function prepararReportes() {
  if (st.tab !== 'reportes') return;
  const vista = filtrarRevision();
  $('#rep-info').textContent = st.rev ? `${num(st.rev.filas.length)} artículos en total · ${num(vista.length)} en la vista de Revisión` : '';
  if ($('#rep-lista').children.length) return;
  $('#rep-lista').innerHTML = Reportes.lista.map((r) => `<div class="tarjeta rep"><h3>${esc(r.titulo)}</h3><p class="muted">${esc(r.descripcion)}</p>
    <div class="fila"><span class="etiqueta e-info">${r.formato === '80mm' ? 'Térmica 80 mm' : 'Carta'}</span><span class="espacio"></span><button class="primario" data-rep="${r.id}">🖨 Imprimir</button></div></div>`).join('');
}
$('#rep-lista').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rep]'); if (!b || !st.rev) return;
  const vista = document.querySelector('input[name=rep-alcance]:checked').value === 'vista';
  imprimirReporte(Reportes.lista.find((r) => r.id === b.dataset.rep), vista ? filtrarRevision() : st.rev.filas, vista ? 'Vista filtrada' : '');
});
$$('[data-exp]').forEach((b) => b.addEventListener('click', () => exportar(b.dataset.exp)));

function imprimirReporte(rep, filas, alcance) {
  const incl = rep.filtrar ? rep.filtrar(filas) : filas;
  if (!incl.length) return toast('No hay artículos para este reporte', 'warn');
  const ctx = { empresa: st.sistema?.empresa || '', inventario: inv(), filas: incl, resumen: resumen(filas), usuario: st.perfil, fecha: new Date().toISOString(), alcance };
  Reportes.imprimir(rep.titulo, rep.formato, rep.generar(ctx));
}

function exportar(tipo) {
  const i = inv(); if (!i || !st.rev) return;
  const nombre = `${tipo}-${i.nombre.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const filas = st.rev.filas;
  if (tipo === 'revision') {
    exportarXlsx(nombre, [['Revision', filas.map((f) => ({
      CODIGO: f.codigo, DESCRIPCION: f.descripcion ?? '(no catalogado)', CATEGORIA: f.categoria ?? '', 'PRECIO VTA': f.precio_vta, COSTO: f.costo,
      TEORICO: f.teorico, CONTADO: f.contado ?? '', CORRECCION: f.correccion ?? '', FINAL: f.final, DIFERENCIA: f.diferencia,
      'DIF $ COSTO': f.dif_costo, 'DIF $ VENTA': f.dif_venta, ESTADO: f.estado, REGISTROS: f.registros, CONTADORES: f.contadores,
    }))]]);
  } else if (tipo === 'ajuste') {
    exportarXlsx(nombre, [
      ['Ajuste', filas.filter((f) => f.diferencia !== 0).map((f) => ({
        CODIGO: f.codigo, DESCRIPCION: f.descripcion ?? '(no catalogado)', 'CANTIDAD SISTEMA': f.teorico, 'CANTIDAD FISICA': f.final,
        AJUSTE: f.diferencia, TIPO: f.diferencia > 0 ? 'ENTRADA' : 'SALIDA', COSTO: f.costo, IMPORTE: f.dif_costo,
      }))],
      ['Inventario fisico', filas.map((f) => ({ CODIGO: f.codigo, DESCRIPCION: f.descripcion ?? '', CANTIDAD: f.final }))],
    ]);
  } else {
    exportarXlsx(nombre, [['Conteos', [...st.conteos].sort((a, b) => String(a.creado).localeCompare(String(b.creado))).map((c) => ({
      CODIGO: c.codigo, 'CODIGO LEIDO': c.codigo_leido, DESCRIPCION: descDe(c.codigo) ?? '', CANTIDAD: c.cantidad, CONTADOR: c.usuario_nombre,
      DISPOSITIVO: c.dispositivo_nombre, ORIGEN: c.origen, FECHA: fecha(c.creado), MODIFICADO: fecha(c.modificado), ELIMINADO: c.eliminado ? 'SI' : '',
    }))]]);
  }
}

// ================= USUARIOS Y DISPOSITIVOS =================
const ROLES = { contador: 'Contador', auditor: 'Auditor', admin: 'Administrador' };
async function cargarUsuarios() {
  try {
    const [us, ds] = await Promise.all([D.listarUsuarios(), D.listarDispositivos()]);
    st.usuarios = us;
    $('#u-lista').innerHTML = us.map((u) => `<tr><td><b>${esc(u.usuario)}</b></td><td>${esc(u.nombre)}</td><td>${ROLES[u.rol]}</td>
      <td>${u.activo ? '<span class="etiqueta e-ok">activo</span>' : '<span class="etiqueta e-faltante">inactivo</span>'}</td>
      <td>${esAdmin() ? `<button class="chico" data-u="${esc(u.uid)}">Editar</button>` : ''}</td></tr>`).join('');
    const t = Date.now();
    $('#d-lista').innerHTML = ds.map((d) => {
      const min = d.ultimo ? Math.round((t - Date.parse(d.ultimo)) / 60000) : null;
      return `<tr><td><b>${esc(d.dispositivo_nombre || '?')}</b></td><td>${esc(d.usuario_nombre)}</td><td>${d.tipo === 'pc' ? 'PC' : 'Celular'}</td>
        <td>${min == null ? '' : min < 2 ? '<span class="etiqueta e-ok">en línea</span>' : `hace ${min < 120 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} días`}`}</td>
        <td><button class="chico" data-qd="${esc(d.id)}" title="Quitar de la lista">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">Sin dispositivos</td></tr>';
  } catch (err) { toast(err.message, 'error'); }
}
$('#b-disp-ref').addEventListener('click', cargarUsuarios);
$('#d-lista').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-qd]'); if (!b) return;
  await D.quitarDispositivo(b.dataset.qd).catch((er) => toast(er.message, 'error'));
  cargarUsuarios();
});
const NOTA_ROLES = '<p class="muted">Contador: sólo captura desde celular. Auditor: revisión, correcciones y edición de cualquier conteo. Administrador: además usuarios y configuración.</p>';
$('#b-nuevo-usuario').addEventListener('click', () => modal({
  titulo: 'Nuevo usuario',
  html: `<label>Usuario (para entrar)</label><input name="usuario" required autocapitalize="none" pattern="[A-Za-z0-9._\\-]{2,40}">
    <label>Nombre completo</label><input name="nombre" required>
    <label>Rol</label><select name="rol">${Object.entries(ROLES).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select>
    <label>Contraseña (mínimo 6 caracteres)</label><input name="password" type="text" minlength="6" required autocomplete="new-password">${NOTA_ROLES}`,
  async alAceptar(f) {
    await D.crearUsuario({ usuario: f.usuario.value.trim(), nombre: f.nombre.value.trim(), rol: f.rol.value, password: f.password.value });
    toast('Usuario creado'); cargarUsuarios();
  },
}));
$('#u-lista').addEventListener('click', (e) => {
  const b = e.target.closest('[data-u]'); if (!b) return;
  const u = st.usuarios.find((x) => x.uid === b.dataset.u);
  modal({
    titulo: `Editar ${u.usuario}`,
    html: `<label>Nombre completo</label><input name="nombre" value="${esc(u.nombre)}" required>
      <label>Rol</label><select name="rol">${Object.entries(ROLES).map(([k, t]) => `<option value="${k}" ${u.rol === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label class="check" style="margin-top:12px"><input type="checkbox" name="activo" style="width:auto" ${u.activo ? 'checked' : ''}> Activo</label>
      ${NOTA_ROLES}<p class="muted">Si el usuario olvidó su contraseña: desactívelo y cree uno nuevo, o restablézcala desde la consola de Firebase (Authentication).</p>`,
    async alAceptar(f) {
      if (u.uid === st.perfil.uid && (!f.activo.checked || f.rol.value !== 'admin')) throw new Error('No puede desactivarse ni quitarse el rol de administrador a sí mismo');
      await D.actualizarUsuario(u.uid, { nombre: f.nombre.value.trim(), rol: f.rol.value, activo: f.activo.checked });
      toast('Usuario actualizado'); cargarUsuarios();
    },
  });
});
$('#b-empresa').addEventListener('click', async () => {
  try { await D.actualizarConfig({ empresa: $('#i-empresa').value.trim() }); toast('Guardado'); } catch (err) { toast(err.message, 'error'); }
});

// ================= BITÁCORA =================
const ACCIONES = {
  conteo_editar: 'Conteo editado', conteo_eliminar: 'Conteo eliminado', conteo_agregar_auditor: 'Conteo agregado por auditor',
  correccion_fijar: 'Corrección', correccion_quitar: 'Corrección eliminada', stock_cargar: 'Carga de stock',
  inventario_crear: 'Inventario creado', inventario_editar: 'Inventario modificado', inventario_activar: 'Inventario activado',
};
let bitacora = [];
async function cargarBitacora() {
  if (!st.invId) return;
  try { bitacora = await D.leerBitacora(st.invId); renderBitacora(); } catch (err) { toast(err.message, 'error'); }
}
function renderBitacora() {
  const q = $('#b-buscar').value.trim().toLowerCase();
  $('#bit-lista').innerHTML = bitacora.filter((b) => !q || JSON.stringify(b).toLowerCase().includes(q)).map((b) => `<tr>
    <td>${esc(fecha(b.ts))}</td><td>${esc(b.usuario_nombre || '')}</td><td>${esc(ACCIONES[b.accion] || b.accion)}</td>
    <td>${esc(b.ref || '')}</td><td class="detalle-bit">${esc(b.detalle || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin movimientos</td></tr>';
}
$('#b-buscar').addEventListener('input', renderBitacora);
$('#b-bit-ref').addEventListener('click', cargarBitacora);

// ================= Utilidades =================
function paginacion(sel, pagina, paginas, total, ir) {
  const el = $(sel);
  if (paginas <= 1) { el.innerHTML = `<span class="muted">${num(total)} filas</span>`; return; }
  el.innerHTML = `<span class="muted">${num(total)} filas · página ${pagina + 1} de ${paginas}</span>
    <button class="chico" data-p="0" ${pagina === 0 ? 'disabled' : ''}>«</button><button class="chico" data-p="${pagina - 1}" ${pagina === 0 ? 'disabled' : ''}>‹</button>
    <button class="chico" data-p="${pagina + 1}" ${pagina >= paginas - 1 ? 'disabled' : ''}>›</button><button class="chico" data-p="${paginas - 1}" ${pagina >= paginas - 1 ? 'disabled' : ''}>»</button>`;
  el.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b && !b.disabled) ir(Number(b.dataset.p)); };
}

// ================= Arranque =================
(async () => {
  try { await D.iniciar(); } catch (e) { $('#v-cargando').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  let sistema = null;
  try { sistema = await D.leerSistema(); } catch (e) { $('#v-cargando').innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  if (!sistema) { mostrar('setup'); return; }
  D.alCambiarSesion((perfil, err) => {
    limpiar(st.subs); limpiar(st.subsInv); st.invId = null;
    if (perfil && perfil.rol !== 'contador') iniciarPanel(perfil);
    else {
      mostrar('login');
      if (err) $('#login-error').textContent = err.message;
      if (perfil) D.salir();
    }
  });
})();
