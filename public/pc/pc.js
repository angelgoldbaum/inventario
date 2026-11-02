// Panel de PC: inventarios/stock, concentrado de conteos, revisión, reportes, usuarios y bitácora
(function () {
  const { $, $$, esc, num, dinero, fecha, toast } = U;
  API.prefijo = 'inv_pc';

  const st = {
    usuario: null,
    config: {},
    inventarios: [],
    invId: null,
    tab: null,
    conteos: [], cPagina: 0,
    rev: null, rFiltradas: [], rPagina: 0, rOrden: [{ k: 'dif_costo', dir: 1 }], rFiltrosCol: {},
    timers: {},
  };
  const POR_PAGINA = 200;
  const inv = () => st.inventarios.find((i) => i.id === st.invId);
  const esAdmin = () => st.usuario?.rol === 'admin';
  const r2 = (n) => Math.round(n * 100) / 100;
  const r4 = (n) => Math.round(n * 1e4) / 1e4;

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
      try { if ((await alAceptar(form)) !== false) cerrar(); } catch (err) { form.querySelector('.error').textContent = err.message; }
    });
    setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 30);
    return { form, cerrar };
  }

  // ================= Login =================
  $('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#login-error').textContent = '';
    try {
      const r = await API.post('/auth/login', { usuario: f.usuario.value.trim(), password: f.password.value, tipo: 'pc', dispositivo_id: API.dispositivoId(), dispositivo_nombre: 'PC ' + (navigator.platform || '') });
      API.token = r.token;
      f.password.value = '';
      await iniciar();
      if (r.debe_cambiar) { toast('Por seguridad cambie la contraseña predeterminada', 'warn', 5000); cambiarPassword(); }
    } catch (err) { $('#login-error').textContent = err.message.includes('fetch') ? 'Sin conexión con el servidor' : err.message; }
  });
  API.alExpirar = () => { API.token = null; mostrarLogin(); };
  function mostrarLogin() { $('#v-app').classList.add('oculto'); $('#v-login').classList.remove('oculto'); Object.values(st.timers).forEach(clearInterval); }

  $('#b-salir').addEventListener('click', async () => { try { await API.post('/auth/logout'); } catch { /* */ } API.token = null; mostrarLogin(); });
  $('#b-pass').addEventListener('click', cambiarPassword);
  function cambiarPassword() {
    modal({
      titulo: 'Cambiar contraseña',
      html: '<label>Contraseña actual</label><input name="actual" type="password" required><label>Nueva contraseña</label><input name="nueva" type="password" minlength="4" required><label>Confirmar</label><input name="conf" type="password" required>',
      async alAceptar(f) {
        if (f.nueva.value !== f.conf.value) throw new Error('Las contraseñas no coinciden');
        await API.put('/auth/password', { actual: f.actual.value, nueva: f.nueva.value });
        toast('Contraseña actualizada');
      },
    });
  }

  async function iniciar() {
    const yo = await API.get('/auth/yo');
    st.usuario = yo.usuario;
    if (st.usuario.rol === 'contador') { API.token = null; return mostrarLogin(); }
    $('#h-usuario').textContent = `${st.usuario.nombre} (${st.usuario.rol})`;
    st.config = await API.get('/config');
    $('#h-empresa').textContent = st.config.empresa;
    $('#i-empresa').value = st.config.empresa;
    $('#cfg-empresa').classList.toggle('oculto', !esAdmin());
    $('#b-nuevo-usuario').classList.toggle('oculto', !esAdmin());
    await cargarInventarios();
    $('#v-login').classList.add('oculto');
    $('#v-app').classList.remove('oculto');
    irTab(API.ls.get('inv_pc_tab') || 'revision');
  }

  // ================= Inventario seleccionado + pestañas =================
  async function cargarInventarios() {
    st.inventarios = await API.get('/inventarios');
    const guardado = Number(API.ls.get('inv_pc_inv'));
    if (!st.inventarios.some((i) => i.id === st.invId)) {
      st.invId = (st.inventarios.find((i) => i.id === guardado) || st.inventarios.find((i) => i.activo) || st.inventarios[0])?.id ?? null;
    }
    $('#sel-inventario').innerHTML = st.inventarios.map((i) => `<option value="${i.id}" ${i.id === st.invId ? 'selected' : ''}>${esc(i.nombre)}${i.activo ? ' ★' : ''}</option>`).join('');
    const i = inv();
    const e = $('#h-estado');
    e.textContent = i ? (i.estado === 'cerrado' ? 'CERRADO' : (i.activo ? 'ACTIVO (celulares)' : 'abierto')) : '';
    e.className = `etiqueta ${i?.estado === 'cerrado' ? 'e-faltante' : (i?.activo ? 'e-ok' : 'e-info')}`;
    $('#stock-destino').textContent = i ? i.nombre : '—';
    renderInventarios();
  }
  $('#sel-inventario').addEventListener('change', async (e) => {
    st.invId = Number(e.target.value);
    API.ls.set('inv_pc_inv', st.invId);
    st.rev = null; st.conteos = [];
    await cargarInventarios();
    irTab(st.tab);
  });

  $$('#pestanas button').forEach((b) => b.addEventListener('click', () => irTab(b.dataset.tab)));
  function irTab(tab) {
    st.tab = tab;
    API.ls.set('inv_pc_tab', tab);
    $$('#pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === tab));
    $$('.tab').forEach((t) => t.classList.toggle('oculto', t.id !== `tab-${tab}`));
    Object.values(st.timers).forEach(clearInterval);
    st.timers = {};
    ({ inventarios: () => cargarInventarios(), conteos: cargarConteos, revision: cargarRevision, reportes: prepararReportes, usuarios: cargarUsuarios, bitacora: cargarBitacora })[tab]?.();
    if (tab === 'conteos') st.timers.c = setInterval(() => { if ($('#c-auto').checked && !document.querySelector('.modal-fondo')) cargarConteos(true); }, 6000);
    if (tab === 'revision') st.timers.r = setInterval(() => {
      if ($('#r-auto').checked && !document.querySelector('.modal-fondo') && !document.activeElement?.classList.contains('corr')) cargarRevision(true);
    }, 15000);
  }

  // ================= INVENTARIOS Y STOCK =================
  function renderInventarios() {
    $('#inv-lista').innerHTML = st.inventarios.map((i) => `<tr>
      <td><b>${esc(i.nombre)}</b>${i.activo ? ' <span class="etiqueta e-ok">activo</span>' : ''}</td>
      <td><span class="etiqueta ${i.estado === 'cerrado' ? 'e-faltante' : 'e-info'}">${i.estado}</span></td>
      <td class="n">${num(i.productos)}</td><td class="n">${num(i.conteos)}</td>
      <td>${i.stock_cargado ? `${esc(fecha(i.stock_cargado))}<br><span class="muted">${esc(i.stock_archivo || '')}</span>` : '<span class="muted">—</span>'}</td>
      <td class="acc">
        ${i.activo ? '' : `<button class="chico" data-act="activar" data-id="${i.id}">Activar</button>`}
        <button class="chico" data-act="${i.estado === 'cerrado' ? 'reabrir' : 'cerrar'}" data-id="${i.id}">${i.estado === 'cerrado' ? 'Reabrir' : 'Cerrar'}</button>
        <button class="chico" data-act="renombrar" data-id="${i.id}">Renombrar</button>
        ${esAdmin() && !i.activo ? `<button class="chico peligro" data-act="eliminar" data-id="${i.id}">Eliminar</button>` : ''}
      </td></tr>`).join('');
  }
  $('#inv-lista').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.dataset.id);
    const i = st.inventarios.find((x) => x.id === id);
    try {
      switch (b.dataset.act) {
        case 'activar': await API.post(`/inventarios/${id}/activar`); toast('Inventario activado para los celulares'); break;
        case 'cerrar': if (!confirm(`¿Cerrar "${i.nombre}"? Ya no se podrán capturar ni modificar conteos.`)) return; await API.put(`/inventarios/${id}`, { estado: 'cerrado' }); break;
        case 'reabrir': await API.put(`/inventarios/${id}`, { estado: 'abierto' }); break;
        case 'renombrar': {
          const n = prompt('Nuevo nombre', i.nombre); if (!n) return;
          await API.put(`/inventarios/${id}`, { nombre: n }); break;
        }
        case 'eliminar':
          if (!confirm(`¿Eliminar DEFINITIVAMENTE "${i.nombre}" con su stock, conteos y correcciones?`)) return;
          await API.del(`/inventarios/${id}`); break;
      }
      await cargarInventarios();
    } catch (err) { toast(err.message, 'error', 4000); }
  });
  $('#b-nuevo-inv').addEventListener('click', () => modal({
    titulo: 'Nuevo inventario',
    html: '<label>Nombre</label><input name="nombre" required placeholder="Ej. Sucursal Centro - Nov 2026"><label>Notas</label><textarea name="notas" rows="2"></textarea><label class="check" style="margin-top:12px"><input type="checkbox" name="activar" checked style="width:auto"> Activarlo para los celulares</label>',
    async alAceptar(f) {
      const r = await API.post('/inventarios', { nombre: f.nombre.value, notas: f.notas.value, activar: f.activar.checked });
      st.invId = r.id; API.ls.set('inv_pc_inv', r.id);
      await cargarInventarios();
      toast('Inventario creado. Ahora cargue el stock teórico.');
    },
  }));

  $('#f-stock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const i = inv();
    if (!i) return;
    if (f.modo.value === 'reemplazar' && i.productos > 0 && !confirm(`Se reemplazará el stock teórico de "${i.nombre}" (${i.productos} artículos). Los conteos no se borran. ¿Continuar?`)) return;
    const fd = new FormData(f);
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Cargando…';
    const out = $('#stock-resultado');
    try {
      const r = await API.req('POST', `/inventarios/${i.id}/stock`, fd);
      out.innerHTML = `<div class="resultado"><b>✔ ${num(r.articulos)} artículos cargados</b> (${r.modo})${r.alternos ? `, ${num(r.alternos)} códigos alternos` : ''}.
        ${r.total_advertencias ? `<div>${r.total_advertencias} advertencia(s):</div><ul>${r.advertencias.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div>`;
      f.archivo.value = '';
      st.rev = null;
      await cargarInventarios();
    } catch (err) {
      out.innerHTML = `<div class="resultado error">${esc(err.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = 'Cargar'; }
  });
  $('#b-plantilla').addEventListener('click', () => API.descargar('/plantilla-stock.xlsx', 'plantilla-stock.xlsx').catch((e) => toast(e.message, 'error')));

  // ================= CONTEOS (concentrado) =================
  async function cargarConteos(silencioso) {
    if (!st.invId) return;
    try {
      const prev = new Set(st.conteos.map((c) => c.id));
      const ver = $('#c-eliminados').checked ? '?eliminados=1' : '';
      st.conteos = await API.get(`/inventarios/${st.invId}/conteos${ver}`);
      st.cNuevos = silencioso ? new Set(st.conteos.filter((c) => !prev.has(c.id)).map((c) => c.id)) : new Set();
      llenarSelect('#c-usuario', [...new Map(st.conteos.map((c) => [c.usuario_id, c.usuario_nombre]))].map(([v, t]) => ({ v, t })), 'Todos los contadores');
      llenarSelect('#c-dispositivo', [...new Set(st.conteos.map((c) => c.dispositivo_nombre || '(sin nombre)'))].map((v) => ({ v, t: v })), 'Todos los dispositivos');
      renderConteos();
    } catch (err) { if (!silencioso) toast(err.message, 'error'); }
  }
  function llenarSelect(sel, opciones, todos) {
    const s = $(sel); const v = s.value;
    s.innerHTML = `<option value="">${todos}</option>` + opciones.sort((a, b) => String(a.t).localeCompare(String(b.t))).map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('');
    s.value = v;
  }
  function conteosFiltrados() {
    const q = $('#c-buscar').value.trim().toLowerCase();
    const u = $('#c-usuario').value; const d = $('#c-dispositivo').value;
    return st.conteos.filter((c) => (!q || c.codigo.toLowerCase().includes(q) || (c.descripcion || '').toLowerCase().includes(q) || (c.codigo_leido || '').toLowerCase().includes(q))
      && (!u || String(c.usuario_id) === u) && (!d || (c.dispositivo_nombre || '(sin nombre)') === d));
  }
  function renderConteos() {
    const lista = conteosFiltrados();
    const activos = lista.filter((c) => !c.eliminado);
    $('#c-resumen').textContent = `${num(activos.length)} registros · ${num(new Set(activos.map((c) => c.codigo)).size)} artículos · ${num(r4(activos.reduce((a, c) => a + c.cantidad, 0)))} piezas`;
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    st.cPagina = Math.min(st.cPagina, paginas - 1);
    const cerrado = inv()?.estado === 'cerrado';
    $('#t-conteos tbody').innerHTML = lista.slice(st.cPagina * POR_PAGINA, (st.cPagina + 1) * POR_PAGINA).map((c) => `
      <tr class="${c.eliminado ? 'eliminado' : ''} ${st.cNuevos?.has(c.id) ? 'nuevo' : ''}">
        <td class="muted">${c.id}</td><td>${esc(fecha(c.creado))}</td>
        <td><a class="codigo" data-cod="${esc(c.codigo)}">${esc(c.codigo)}</a>${c.codigo_leido && c.codigo_leido !== c.codigo ? `<br><span class="muted">leído: ${esc(c.codigo_leido)}</span>` : ''}</td>
        <td class="desc">${c.no_catalogado ? '<span class="etiqueta e-no_catalogado">no catalogado</span>' : esc(c.descripcion)}</td>
        <td class="n"><b>${num(c.cantidad)}</b></td><td>${esc(c.usuario_nombre)}</td><td>${esc(c.dispositivo_nombre || '')}</td>
        <td>${c.origen === 'auditor' ? '<span class="etiqueta e-info">auditor</span>' : 'móvil'}</td>
        <td>${c.modificado ? `${esc(fecha(c.modificado))}<br><span class="muted">${esc(c.modificado_por_nombre || '')}</span>` : ''}</td>
        <td class="acc">${c.eliminado || cerrado ? '' : `<button class="chico" data-ed="${c.id}">Editar</button><button class="chico peligro" data-del="${c.id}">Eliminar</button>`}</td>
      </tr>`).join('') || '<tr><td colspan="10" class="muted">Sin conteos</td></tr>';
    paginacion('#c-pag', st.cPagina, paginas, lista.length, (p) => { st.cPagina = p; renderConteos(); });
  }
  ['#c-buscar', '#c-usuario', '#c-dispositivo'].forEach((s) => $(s).addEventListener('input', () => { st.cPagina = 0; renderConteos(); }));
  $('#c-eliminados').addEventListener('change', () => cargarConteos());
  $('#t-conteos').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-cod]'); if (a) return detalleArticulo(a.dataset.cod);
    const ed = e.target.closest('[data-ed]'); if (ed) return editarConteo(st.conteos.find((c) => c.id === Number(ed.dataset.ed)), () => cargarConteos());
    const del = e.target.closest('[data-del]'); if (del) return eliminarConteo(st.conteos.find((c) => c.id === Number(del.dataset.del)), () => cargarConteos());
  });
  $('#c-agregar').addEventListener('click', () => agregarConteo(null, () => cargarConteos()));
  $('#c-excel').addEventListener('click', () => exportar('conteos'));

  function editarConteo(c, despues) {
    modal({
      titulo: `Editar conteo #${c.id}`,
      html: `<p class="muted">Capturado por <b>${esc(c.usuario_nombre)}</b> en ${esc(c.dispositivo_nombre || '?')} — ${esc(fecha(c.creado))}</p>
        <label>Código</label><input name="codigo" value="${esc(c.codigo)}" required>
        <label>Cantidad</label><input name="cantidad" type="number" step="any" min="0" value="${c.cantidad}" required>`,
      async alAceptar(f) {
        await API.put(`/conteos/${c.id}`, { codigo: f.codigo.value, cantidad: f.cantidad.value });
        toast('Conteo actualizado'); st.rev = null; despues?.();
      },
    });
  }
  async function eliminarConteo(c, despues) {
    if (!confirm(`¿Eliminar el conteo #${c.id}: ${c.codigo} × ${num(c.cantidad)} de ${c.usuario_nombre}?`)) return;
    try { await API.del(`/conteos/${c.id}`); toast('Conteo eliminado'); st.rev = null; despues?.(); } catch (err) { toast(err.message, 'error'); }
  }
  async function agregarConteo(codigo, despues) {
    let usuarios = [];
    try { usuarios = await API.get('/usuarios'); } catch { /* */ }
    modal({
      titulo: 'Agregar conteo (auditor)',
      html: `<label>Código</label><input name="codigo" value="${esc(codigo || '')}" required><div class="muted" id="m-desc"></div>
        <label>Cantidad</label><input name="cantidad" type="number" step="any" min="0" required>
        <label>Registrar a nombre de</label><select name="usuario_id">${usuarios.filter((u) => u.activo).map((u) => `<option value="${u.id}" ${u.id === st.usuario.id ? 'selected' : ''}>${esc(u.nombre)} (${u.rol})</option>`).join('')}</select>`,
      async alAceptar(f) {
        const r = await API.post(`/inventarios/${st.invId}/conteos`, { codigo: f.codigo.value, cantidad: f.cantidad.value, usuario_id: f.usuario_id.value });
        toast(r.no_catalogado ? 'Conteo agregado (código no catalogado)' : 'Conteo agregado', r.no_catalogado ? 'warn' : 'ok');
        st.rev = null; despues?.();
      },
    });
    const f = document.querySelector('.modal-fondo:last-child form');
    const buscar = async () => {
      if (!f.codigo.value.trim()) return;
      try {
        const p = await API.get(`/productos/buscar?inventario_id=${st.invId}&codigo=${encodeURIComponent(f.codigo.value)}`);
        f.querySelector('#m-desc').textContent = p.encontrado ? p.descripcion : '⚠ No existe en el stock teórico';
      } catch { /* */ }
    };
    f.codigo.addEventListener('change', buscar);
    if (codigo) { buscar(); setTimeout(() => f.cantidad.focus(), 50); }
  }

  // Detalle de un artículo: todos sus conteos con edición
  async function detalleArticulo(codigo) {
    let lista, fila;
    try {
      lista = await API.get(`/inventarios/${st.invId}/conteos?codigo=${encodeURIComponent(codigo)}&eliminados=1`);
      fila = st.rev?.filas.find((x) => x.codigo === codigo);
    } catch (err) { return toast(err.message, 'error'); }
    const cerrado = inv()?.estado === 'cerrado';
    const m = modal({
      titulo: `${codigo} — ${fila?.descripcion || lista[0]?.descripcion || 'No catalogado'}`,
      ancho: 860, ok: null, cancelar: 'Cerrar',
      html: `${fila ? `<div class="kpis"><div class="kpi"><span>Teórico</span><b>${num(fila.teorico)}</b></div><div class="kpi"><span>Contado</span><b>${num(fila.contado ?? 0)}</b></div>
          <div class="kpi"><span>Corrección</span><b>${fila.correccion != null ? num(fila.correccion) : '—'}</b></div><div class="kpi"><span>Diferencia</span><b class="${fila.diferencia < 0 ? 'neg' : fila.diferencia > 0 ? 'pos' : ''}">${num(fila.diferencia)}</b></div>
          <div class="kpi"><span>Dif. $ costo</span><b>${dinero(fila.dif_costo)}</b></div></div>` : ''}
        <table class="tabla"><thead><tr><th>#</th><th>Fecha</th><th class="n">Cantidad</th><th>Contador</th><th>Dispositivo</th><th>Leído</th><th></th></tr></thead><tbody>
        ${lista.map((c) => `<tr class="${c.eliminado ? 'eliminado' : ''}"><td>${c.id}</td><td>${esc(fecha(c.creado))}</td><td class="n"><b>${num(c.cantidad)}</b></td><td>${esc(c.usuario_nombre)}</td><td>${esc(c.dispositivo_nombre || '')}</td><td>${esc(c.codigo_leido || '')}</td>
          <td class="acc">${c.eliminado || cerrado ? '' : `<button type="button" class="chico" data-ed="${c.id}">Editar</button><button type="button" class="chico peligro" data-del="${c.id}">Eliminar</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin conteos</td></tr>'}
        </tbody></table>
        ${cerrado ? '' : '<div style="margin-top:10px"><button type="button" class="primario" data-add>+ Agregar conteo a este artículo</button></div>'}`,
    });
    const refrescar = () => { m.cerrar(); refrescarTab(); detalleArticulo(codigo); };
    m.form.addEventListener('click', (e) => {
      const ed = e.target.closest('[data-ed]'); if (ed) editarConteo(lista.find((c) => c.id === Number(ed.dataset.ed)), refrescar);
      const del = e.target.closest('[data-del]'); if (del) eliminarConteo(lista.find((c) => c.id === Number(del.dataset.del)), refrescar);
      if (e.target.closest('[data-add]')) agregarConteo(codigo, refrescar);
    });
  }
  function refrescarTab() { if (st.tab === 'revision') cargarRevision(true); if (st.tab === 'conteos') cargarConteos(true); }

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

  async function cargarRevision(silencioso) {
    if (!st.invId) return;
    try {
      st.rev = await API.get(`/inventarios/${st.invId}/revision`);
      const cats = [...new Set(st.rev.filas.map((f) => f.categoria).filter(Boolean))].sort();
      colsVisibles = COLS.filter((c) => !c.opcional || cats.length);
      const sc = $('#r-categoria'); const v = sc.value;
      sc.innerHTML = '<option value="">Todas las categorías</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
      sc.value = v; sc.classList.toggle('oculto', !cats.length);
      renderEncabezado();
      renderRevision();
    } catch (err) { if (!silencioso) toast(err.message, 'error'); }
  }

  function recalcular(f) {
    f.final = f.correccion != null ? f.correccion : (f.contado ?? 0);
    f.diferencia = r4(f.final - f.teorico);
    f.dif_costo = r2(f.diferencia * f.costo);
    f.dif_venta = r2(f.diferencia * f.precio_vta);
    f.valor_final = r2(f.final * f.costo);
    f.estado = f.no_catalogado ? 'no_catalogado' : f.diferencia < 0 ? 'faltante' : f.diferencia > 0 ? 'sobrante' : 'ok';
  }

  function resumen(filas) {
    const s = { articulos: filas.length, contados: 0, sin_contar: 0, con_diferencia: 0, faltantes: 0, sobrantes: 0, corregidos: 0, no_catalogados: 0,
      piezas_teorico: 0, piezas_final: 0, valor_teorico: 0, valor_final: 0, costo_faltante: 0, costo_sobrante: 0, venta_faltante: 0, venta_sobrante: 0, pz_falt: 0, pz_sobr: 0 };
    for (const f of filas) {
      f.sin_contar ? s.sin_contar++ : s.contados++;
      if (f.correccion != null) s.corregidos++;
      if (f.no_catalogado) s.no_catalogados++;
      if (f.diferencia) s.con_diferencia++;
      if (f.diferencia < 0) { s.faltantes++; s.costo_faltante += f.dif_costo; s.venta_faltante += f.dif_venta; s.pz_falt += f.diferencia; }
      if (f.diferencia > 0) { s.sobrantes++; s.costo_sobrante += f.dif_costo; s.venta_sobrante += f.dif_venta; s.pz_sobr += f.diferencia; }
      s.piezas_teorico += f.teorico; s.piezas_final += f.final; s.valor_teorico += f.valor_teorico; s.valor_final += f.valor_final;
    }
    s.costo_neto = s.costo_faltante + s.costo_sobrante;
    s.venta_neta = s.venta_faltante + s.venta_sobrante;
    return s;
  }

  function renderKpis() {
    const s = resumen(st.rev.filas);
    const avance = s.articulos ? (100 * s.contados / s.articulos).toFixed(1) : '0';
    $('#r-kpis').innerHTML = `
      <div class="kpi"><span>Artículos</span><b>${num(s.articulos)}</b> <small>${s.no_catalogados ? `${s.no_catalogados} no catalogados` : ''}</small></div>
      <div class="kpi"><span>Avance de conteo</span><b>${avance}%</b> <small>${num(s.contados)} contados · ${num(s.sin_contar)} sin contar</small></div>
      <div class="kpi"><span>Con diferencia</span><b>${num(s.con_diferencia)}</b> <small>${num(s.faltantes)} falt. · ${num(s.sobrantes)} sobr. · ${num(s.corregidos)} corr.</small></div>
      <div class="kpi"><span>Piezas teórico → físico</span><b>${num(r4(s.piezas_teorico))} → ${num(r4(s.piezas_final))}</b> <small>${num(r4(s.pz_falt))} / +${num(r4(s.pz_sobr))}</small></div>
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
    if (e.shiftKey) { if (i >= 0) st.rOrden[i].dir *= -1; else st.rOrden.push({ k, dir: 1 }); }
    else st.rOrden = [{ k, dir: i === 0 && st.rOrden.length === 1 ? -st.rOrden[0].dir : 1 }];
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
    const q = $('#r-buscar').value.trim().toLowerCase();
    const est = $('#r-estado').value;
    const cat = $('#r-categoria').value;
    const filtrosCol = Object.entries(st.rFiltrosCol).filter(([, v]) => v.trim());
    const tipos = Object.fromEntries(COLS.map((c) => [c.k, c.tipo]));
    let filas = st.rev.filas.filter((f) => {
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
        if (tipos[k] === 'num') { if (!coincideNum(f[k], v)) return false; }
        else {
          const val = k === 'estado' ? ESTADOS[f.estado] : f[k];
          if (!String(val ?? '').toLowerCase().includes(v.trim().toLowerCase())) return false;
        }
      }
      return true;
    });
    const cmp = (a, b) => {
      for (const { k, dir } of st.rOrden) {
        const x = a[k]; const y = b[k];
        if (x == null && y == null) continue;
        if (x == null) return 1; if (y == null) return -1;
        const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true });
        if (r) return r * dir;
      }
      return 0;
    };
    return filas.sort(cmp);
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
    if (!st.rev) return;
    renderKpis();
    st.rFiltradas = filtrarRevision();
    const paginas = Math.max(1, Math.ceil(st.rFiltradas.length / POR_PAGINA));
    st.rPagina = Math.min(st.rPagina, paginas - 1);
    const pag = st.rFiltradas.slice(st.rPagina * POR_PAGINA, (st.rPagina + 1) * POR_PAGINA);
    $('#t-revision tbody').innerHTML = pag.map((f) => `<tr data-cod="${esc(f.codigo)}">${colsVisibles.map((c) => celda(c, f)).join('')}</tr>`).join('')
      || `<tr><td colspan="${colsVisibles.length}" class="muted">${st.rev.filas.length ? 'Ningún artículo coincide con los filtros' : 'Cargue el stock teórico y/o capture conteos'}</td></tr>`;
    renderPie();
    paginacion('#r-pag', st.rPagina, paginas, st.rFiltradas.length, (p) => { st.rPagina = p; renderRevision(); });
  }

  function renderPie() {
    const F = st.rFiltradas;
    const sum = (k) => F.reduce((a, f) => a + (f[k] || 0), 0);
    $('#t-revision tfoot').innerHTML = `<tr>${colsVisibles.map((c, i) => {
      if (i === 0) return `<td>${num(F.length)} art.</td>`;
      if (['teorico', 'contado', 'final', 'diferencia', 'registros'].includes(c.k)) return `<td class="n">${num(r4(sum(c.k)))}</td>`;
      if (['dif_costo', 'dif_venta'].includes(c.k)) return `<td class="n">${dinero(sum(c.k))}</td>`;
      return '<td></td>';
    }).join('')}</tr>`;
  }

  function actualizarFila(f) {
    const tr = $(`#t-revision tbody tr[data-cod="${CSS.escape(f.codigo)}"]`);
    if (!tr) return;
    colsVisibles.forEach((c, i) => { if (!c.editable) tr.children[i].outerHTML = celda(c, f); });
    const inp = tr.querySelector('input.corr');
    inp.classList.toggle('con-valor', f.correccion != null);
    renderKpis(); renderPie();
  }

  async function guardarCorreccion(inp) {
    const f = st.rev.filas.find((x) => x.codigo === inp.dataset.cod);
    const txt = inp.value.trim().replace(',', '.');
    const nuevo = txt === '' ? null : Number(txt);
    if (nuevo !== null && (!Number.isFinite(nuevo) || nuevo < 0)) { toast('Cantidad inválida', 'error'); inp.value = f.correccion ?? ''; return; }
    if (nuevo === f.correccion) return;
    inp.classList.add('guardando');
    try {
      await API.put(`/inventarios/${st.invId}/correcciones/${encodeURIComponent(f.codigo)}`, { cantidad: nuevo });
      f.correccion = nuevo;
      f.correccion_usuario = st.usuario.nombre; f.correccion_fecha = new Date().toISOString();
      recalcular(f);
      actualizarFila(f);
    } catch (err) { toast(err.message, 'error'); inp.value = f.correccion ?? ''; }
    finally { inp.classList.remove('guardando'); }
  }
  const tbodyRev = $('#t-revision tbody');
  tbodyRev.addEventListener('keydown', (e) => {
    const inp = e.target.closest('input.corr'); if (!inp) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const todos = $$('input.corr', tbodyRev);
      const sig = todos[todos.indexOf(inp) + (e.key === 'ArrowUp' ? -1 : 1)];
      if (sig) { sig.focus(); sig.select(); } else inp.blur();
    } else if (e.key === 'Escape') {
      const f = st.rev.filas.find((x) => x.codigo === inp.dataset.cod); inp.value = f.correccion ?? ''; inp.blur();
    }
  });
  tbodyRev.addEventListener('focusout', (e) => { if (e.target.matches('input.corr')) guardarCorreccion(e.target); });
  tbodyRev.addEventListener('focusin', (e) => { if (e.target.matches('input.corr')) e.target.select(); });
  tbodyRev.addEventListener('click', (e) => { const a = e.target.closest('a[data-cod]'); if (a) detalleArticulo(a.dataset.cod); });

  ['#r-buscar', '#r-estado', '#r-categoria'].forEach((s) => $(s).addEventListener('input', () => { st.rPagina = 0; renderRevision(); }));
  $('#r-limpiar').addEventListener('click', () => { $('#r-buscar').value = ''; $('#r-estado').value = ''; $('#r-categoria').value = ''; st.rFiltrosCol = {}; renderEncabezado(); renderRevision(); });
  $('#r-refrescar').addEventListener('click', () => cargarRevision());
  $('#r-excel').addEventListener('click', () => exportar('revision'));
  $('#r-ticket').addEventListener('click', () => {
    if (!st.rev) return;
    const filtros = [$('#r-estado').selectedOptions[0].text, $('#r-buscar').value && `"${$('#r-buscar').value}"`, $('#r-categoria').value].filter(Boolean).join(' · ');
    imprimirReporte(Reportes.lista.find((r) => r.id === 'dif-ticket'), st.rFiltradas, `Filtro: ${filtros}`);
  });

  // ================= REPORTES =================
  async function prepararReportes() {
    if (!st.rev) await cargarRevision(true);
    if (st.rev && !st.rFiltradas.length && st.rev.filas.length) st.rFiltradas = filtrarRevision();
    $('#rep-info').textContent = st.rev ? `${num(st.rev.filas.length)} artículos en total · ${num(st.rFiltradas.length)} en la vista de Revisión` : '';
    $('#rep-lista').innerHTML = Reportes.lista.map((r) => `<div class="tarjeta rep"><h3>${esc(r.titulo)}</h3><p class="muted">${esc(r.descripcion)}</p>
      <div class="fila"><span class="etiqueta e-info">${r.formato === '80mm' ? 'Térmica 80 mm' : 'Carta'}</span><span class="espacio"></span><button class="primario" data-rep="${r.id}">🖨 Imprimir</button></div></div>`).join('');
  }
  $('#rep-lista').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rep]'); if (!b) return;
    await cargarRevision(true);
    const vista = document.querySelector('input[name=rep-alcance]:checked').value === 'vista';
    const filas = vista ? filtrarRevision() : st.rev.filas;
    imprimirReporte(Reportes.lista.find((r) => r.id === b.dataset.rep), filas, vista ? 'Vista filtrada' : '');
  });
  $$('[data-exp]').forEach((b) => b.addEventListener('click', () => exportar(b.dataset.exp)));

  function imprimirReporte(rep, filas, alcance) {
    const incl = rep.filtrar ? rep.filtrar(filas) : filas;
    if (!incl.length) return toast('No hay artículos para este reporte', 'warn');
    const ctx = { empresa: st.config.empresa, inventario: st.rev.inventario, filas: incl, resumen: resumen(filas), usuario: st.usuario, fecha: new Date().toISOString(), alcance };
    Reportes.imprimir(rep.titulo, rep.formato, rep.generar(ctx));
  }
  function exportar(tipo) {
    const nombre = `${tipo}-${(inv()?.nombre || 'inventario').replace(/[^\w-]+/g, '_')}.xlsx`;
    API.descargar(`/inventarios/${st.invId}/export/${tipo}.xlsx`, nombre).catch((e) => toast(e.message, 'error'));
  }

  // ================= USUARIOS Y DISPOSITIVOS =================
  const ROLES = { contador: 'Contador', auditor: 'Auditor', admin: 'Administrador' };
  async function cargarUsuarios() {
    try {
      const [us, ds] = await Promise.all([API.get('/usuarios'), API.get('/sesiones')]);
      st.usuarios = us;
      $('#u-lista').innerHTML = us.map((u) => `<tr><td><b>${esc(u.usuario)}</b></td><td>${esc(u.nombre)}</td><td>${ROLES[u.rol]}</td>
        <td>${u.activo ? '<span class="etiqueta e-ok">activo</span>' : '<span class="etiqueta e-faltante">inactivo</span>'}</td>
        <td>${esAdmin() ? `<button class="chico" data-u="${u.id}">Editar</button>` : ''}</td></tr>`).join('');
      const ahora = Date.now();
      $('#d-lista').innerHTML = ds.map((d) => {
        const min = Math.round((ahora - Date.parse(d.ultimo)) / 60000);
        return `<tr><td><b>${esc(d.dispositivo_nombre || '?')}</b></td><td>${esc(d.nombre)}</td><td>${d.tipo === 'pc' ? 'PC' : 'Celular'}</td><td class="muted">${esc(d.ip || '')}</td>
          <td>${min < 2 ? '<span class="etiqueta e-ok">en línea</span>' : `hace ${min < 120 ? `${min} min` : `${Math.round(min / 60)} h`}`}</td><td class="n">${num(d.conteos)}</td>
          <td>${d.dispositivo_id ? `<button class="chico peligro" data-desc="${esc(d.dispositivo_id)}">Desconectar</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="muted">Sin dispositivos</td></tr>';
    } catch (err) { toast(err.message, 'error'); }
  }
  $('#b-disp-ref').addEventListener('click', cargarUsuarios);
  $('#d-lista').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-desc]'); if (!b) return;
    if (!confirm('¿Cerrar la sesión de este dispositivo?')) return;
    await API.del(`/sesiones/dispositivo/${encodeURIComponent(b.dataset.desc)}`).catch((er) => toast(er.message, 'error'));
    cargarUsuarios();
  });
  const formUsuario = (u) => `
    ${u ? '' : '<label>Usuario (para entrar)</label><input name="usuario" required autocapitalize="none">'}
    <label>Nombre completo</label><input name="nombre" value="${esc(u?.nombre || '')}" required>
    <label>Rol</label><select name="rol">${Object.entries(ROLES).map(([k, t]) => `<option value="${k}" ${u?.rol === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label>${u ? 'Nueva contraseña (vacío = sin cambio)' : 'Contraseña'}</label><input name="password" type="text" ${u ? '' : 'required'} autocomplete="new-password">
    ${u ? `<label class="check" style="margin-top:12px"><input type="checkbox" name="activo" style="width:auto" ${u.activo ? 'checked' : ''}> Activo</label>` : ''}
    <p class="muted">Contador: sólo captura desde celular. Auditor: revisión, correcciones y edición de cualquier conteo. Administrador: además usuarios y configuración.</p>`;
  $('#b-nuevo-usuario').addEventListener('click', () => modal({
    titulo: 'Nuevo usuario', html: formUsuario(null),
    async alAceptar(f) { await API.post('/usuarios', { usuario: f.usuario.value, nombre: f.nombre.value, rol: f.rol.value, password: f.password.value }); toast('Usuario creado'); cargarUsuarios(); },
  }));
  $('#u-lista').addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    const u = st.usuarios.find((x) => x.id === Number(b.dataset.u));
    modal({
      titulo: `Editar ${u.usuario}`, html: formUsuario(u),
      async alAceptar(f) { await API.put(`/usuarios/${u.id}`, { nombre: f.nombre.value, rol: f.rol.value, activo: f.activo.checked, password: f.password.value || undefined }); toast('Usuario actualizado'); cargarUsuarios(); },
    });
  });
  $('#b-empresa').addEventListener('click', async () => {
    try { await API.put('/config', { empresa: $('#i-empresa').value }); st.config.empresa = $('#i-empresa').value; $('#h-empresa').textContent = st.config.empresa; toast('Guardado'); } catch (err) { toast(err.message, 'error'); }
  });

  // ================= BITÁCORA =================
  const ACCIONES = {
    login: 'Inicio de sesión', conteo_crear: 'Conteo capturado', conteo_editar: 'Conteo editado', conteo_eliminar: 'Conteo eliminado',
    conteo_agregar_auditor: 'Conteo agregado por auditor', correccion_fijar: 'Corrección', correccion_quitar: 'Corrección eliminada',
    stock_cargar: 'Carga de stock', inventario_crear: 'Inventario creado', inventario_editar: 'Inventario modificado', inventario_activar: 'Inventario activado',
  };
  let bitacora = [];
  async function cargarBitacora() {
    try { bitacora = await API.get(`/inventarios/${st.invId}/bitacora`); renderBitacora(); } catch (err) { toast(err.message, 'error'); }
  }
  function renderBitacora() {
    const q = $('#b-buscar').value.trim().toLowerCase();
    $('#bit-lista').innerHTML = bitacora.filter((b) => !q || JSON.stringify(b).toLowerCase().includes(q)).map((b) => `<tr>
      <td>${esc(fecha(b.ts))}</td><td>${esc(b.usuario || '')}</td><td>${esc(ACCIONES[b.accion] || b.accion)}</td>
      <td>${esc(b.entidad_id || '')}</td><td class="detalle-bit">${esc(b.detalle || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin movimientos</td></tr>';
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
  if (API.token) iniciar().catch(() => mostrarLogin());
  else mostrarLogin();
})();
