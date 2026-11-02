// Inventarios (sesiones de conteo), carga de stock teórico y catálogo de productos
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, transaccion, getConfig, setConfig, bitacora } = require('../db');
const { requiereRol, HttpError } = require('../auth');
const { ah, aNumero, normalizarEncabezado, normalizarCodigo, obtenerInventario, inventarioActivo, resolverProducto } = require('../util');

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Columnas reconocidas en el archivo de stock. Los alias permiten aceptar variaciones de nombre.
// Para soportar nuevas columnas (p.ej. MARCA, PROVEEDOR) agrégalas aquí; lo no reconocido se guarda en "extra".
const COLUMNAS = {
  codigo: { req: true, alias: ['CODIGO', 'SKU', 'CLAVE', 'COD'] },
  descripcion: { req: true, alias: ['DESCRIPCION', 'DESC', 'ARTICULO', 'PRODUCTO'] },
  precio_vta: { req: true, alias: ['PRECIO VTA', 'PRECIO VENTA', 'PRECIO', 'PVTA', 'P VTA'] },
  costo: { req: true, alias: ['COSTO', 'COSTO UNITARIO', 'COSTO UNIT'] },
  cantidad: { req: true, alias: ['CANTIDAD', 'EXISTENCIA', 'STOCK', 'CANT'] },
  categoria: { req: false, alias: ['CATEGORIA', 'LINEA', 'FAMILIA', 'DEPARTAMENTO'] },
  ubicacion: { req: false, alias: ['UBICACION', 'ALMACEN', 'PASILLO'] },
  codigo_barras: { req: false, alias: ['CODIGO BARRAS', 'CODIGO DE BARRAS', 'CODIGOS BARRAS', 'EAN', 'UPC', 'CODIGO ALTERNO'] },
};

// ---- Inventarios ----
r.get('/inventarios', ah((req, res) => {
  const rows = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM productos p WHERE p.inventario_id = i.id) productos,
      (SELECT COUNT(*) FROM conteos c WHERE c.inventario_id = i.id AND c.eliminado = 0) conteos
    FROM inventarios i ORDER BY i.id DESC`).all();
  const activo = Number(getConfig('inventario_activo')) || null;
  res.json(rows.map((x) => ({ ...x, activo: x.id === activo })));
}));

r.get('/inventarios/activo', ah((req, res) => {
  const inv = inventarioActivo();
  res.json({ id: inv.id, nombre: inv.nombre, estado: inv.estado, empresa: getConfig('empresa') });
}));

r.post('/inventarios', requiereRol('auditor'), ah((req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  if (!nombre) throw new HttpError(400, 'Indique un nombre');
  const x = db.prepare('INSERT INTO inventarios(nombre, notas) VALUES (?,?)').run(nombre, req.body?.notas || null);
  if (req.body?.activar) setConfig('inventario_activo', x.lastInsertRowid);
  bitacora(req, 'inventario_crear', { inventario_id: x.lastInsertRowid, detalle: { nombre } });
  res.json({ id: x.lastInsertRowid });
}));

r.put('/inventarios/:id', requiereRol('auditor'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  const { nombre, notas, estado } = req.body || {};
  if (estado && !['abierto', 'cerrado'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  db.prepare(`UPDATE inventarios SET nombre = ?, notas = ?, estado = ?,
      cerrado = CASE WHEN ? = 'cerrado' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id = ?`)
    .run(nombre ?? inv.nombre, notas ?? inv.notas, estado ?? inv.estado, estado ?? inv.estado, inv.id);
  bitacora(req, 'inventario_editar', { inventario_id: inv.id, detalle: req.body });
  res.json({ ok: true });
}));

r.post('/inventarios/:id/activar', requiereRol('auditor'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  setConfig('inventario_activo', inv.id);
  bitacora(req, 'inventario_activar', { inventario_id: inv.id });
  res.json({ ok: true });
}));

r.delete('/inventarios/:id', requiereRol('admin'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  if (Number(getConfig('inventario_activo')) === inv.id) throw new HttpError(409, 'No se puede eliminar el inventario activo');
  db.prepare('DELETE FROM inventarios WHERE id = ?').run(inv.id);
  bitacora(req, 'inventario_eliminar', { inventario_id: inv.id, detalle: { nombre: inv.nombre } });
  res.json({ ok: true });
}));

// ---- Carga de stock teórico ----
function leerArchivo(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false, codepage: 65001 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  // busca la fila de encabezados en las primeras 20 filas
  let idxEnc = -1, mapa = null;
  for (let i = 0; i < Math.min(20, filas.length); i++) {
    const enc = filas[i].map(normalizarEncabezado);
    const m = {};
    for (const [campo, def] of Object.entries(COLUMNAS)) {
      const j = enc.findIndex((h) => def.alias.includes(h));
      if (j >= 0) m[campo] = j;
    }
    if (m.codigo != null && m.cantidad != null) { idxEnc = i; mapa = m; break; }
  }
  if (idxEnc < 0) throw new HttpError(400, 'No se encontraron los encabezados. Columnas esperadas: CODIGO, DESCRIPCION, PRECIO VTA, COSTO, CANTIDAD');
  const faltan = Object.entries(COLUMNAS).filter(([k, d]) => d.req && mapa[k] == null).map(([, d]) => d.alias[0]);
  if (faltan.length) throw new HttpError(400, `Faltan columnas: ${faltan.join(', ')}`);
  const encOriginal = filas[idxEnc];
  const usadas = new Set(Object.values(mapa));
  return { filas: filas.slice(idxEnc + 1), mapa, encOriginal, usadas, filaInicio: idxEnc + 2 };
}

r.post('/inventarios/:id/stock', requiereRol('auditor'), upload.single('archivo'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  if (!req.file) throw new HttpError(400, 'Adjunte un archivo .xlsx, .xls o .csv');
  const modo = req.body?.modo === 'actualizar' ? 'actualizar' : 'reemplazar';
  const { filas, mapa, encOriginal, usadas, filaInicio } = leerArchivo(req.file.buffer);

  const productos = new Map();
  const alternos = [];
  const advertencias = [];
  filas.forEach((f, i) => {
    const nFila = filaInicio + i;
    const codigo = normalizarCodigo(f[mapa.codigo]);
    if (!codigo) { if (f.some((v) => v !== '')) advertencias.push(`Fila ${nFila}: sin código, se omitió`); return; }
    const p = {
      codigo,
      descripcion: String(f[mapa.descripcion] ?? '').trim(),
      precio_vta: aNumero(f[mapa.precio_vta]),
      costo: aNumero(f[mapa.costo]),
      cantidad: aNumero(f[mapa.cantidad]),
      categoria: mapa.categoria != null ? String(f[mapa.categoria] ?? '').trim() || null : null,
      ubicacion: mapa.ubicacion != null ? String(f[mapa.ubicacion] ?? '').trim() || null : null,
    };
    for (const k of ['precio_vta', 'costo', 'cantidad']) {
      if (Number.isNaN(p[k])) { advertencias.push(`Fila ${nFila} (${codigo}): ${k.toUpperCase()} no numérico, se tomó 0`); p[k] = 0; }
    }
    const extra = {};
    encOriginal.forEach((h, j) => { if (!usadas.has(j) && h !== '' && f[j] !== '') extra[String(h)] = f[j]; });
    p.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
    if (productos.has(codigo)) {
      const prev = productos.get(codigo);
      prev.cantidad += p.cantidad;
      advertencias.push(`Fila ${nFila}: código ${codigo} duplicado, se sumaron las cantidades`);
    } else productos.set(codigo, p);
    if (mapa.codigo_barras != null) {
      String(f[mapa.codigo_barras] ?? '').split(/[,;|\s]+/).map(normalizarCodigo).filter((x) => x && x !== codigo)
        .forEach((alt) => alternos.push([alt, codigo]));
    }
  });
  if (!productos.size) throw new HttpError(400, 'El archivo no contiene artículos');

  transaccion(() => {
    if (modo === 'reemplazar') {
      db.prepare('DELETE FROM productos WHERE inventario_id = ?').run(inv.id);
      db.prepare('DELETE FROM codigos_alternos WHERE inventario_id = ?').run(inv.id);
    }
    const ins = db.prepare(`INSERT INTO productos(inventario_id, codigo, descripcion, precio_vta, costo, cantidad, categoria, ubicacion, extra)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(inventario_id, codigo) DO UPDATE SET descripcion=excluded.descripcion, precio_vta=excluded.precio_vta,
        costo=excluded.costo, cantidad=excluded.cantidad, categoria=excluded.categoria, ubicacion=excluded.ubicacion, extra=excluded.extra`);
    for (const p of productos.values()) ins.run(inv.id, p.codigo, p.descripcion, p.precio_vta, p.costo, p.cantidad, p.categoria, p.ubicacion, p.extra);
    const insAlt = db.prepare('INSERT OR REPLACE INTO codigos_alternos(inventario_id, alterno, codigo) VALUES (?,?,?)');
    for (const [alt, cod] of alternos) insAlt.run(inv.id, alt, cod);
    db.prepare(`UPDATE inventarios SET stock_archivo = ?, stock_cargado = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(req.file.originalname, inv.id);
  });
  bitacora(req, 'stock_cargar', { inventario_id: inv.id, detalle: { archivo: req.file.originalname, modo, articulos: productos.size } });
  res.json({ ok: true, modo, articulos: productos.size, alternos: alternos.length, advertencias: advertencias.slice(0, 200), total_advertencias: advertencias.length });
}));

r.get('/plantilla-stock.xlsx', ah((req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['CODIGO', 'DESCRIPCION', 'PRECIO VTA', 'COSTO', 'CANTIDAD', 'CATEGORIA', 'CODIGO BARRAS'],
    ['A001', 'Artículo de ejemplo', 25.5, 15.2, 10, 'General', '7501234567890'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-stock.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));

// ---- Productos ----
r.get('/inventarios/:id/productos', requiereRol('auditor'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  res.json(db.prepare('SELECT codigo, descripcion, precio_vta, costo, cantidad, categoria FROM productos WHERE inventario_id = ? ORDER BY codigo').all(inv.id));
}));

// Búsqueda de un código (escaneado o tecleado) en el inventario activo o indicado
r.get('/productos/buscar', ah((req, res) => {
  const inv = req.query.inventario_id ? obtenerInventario(req.query.inventario_id) : inventarioActivo();
  const p = resolverProducto(inv.id, req.query.codigo);
  if (!p) return res.json({ encontrado: false, codigo: normalizarCodigo(req.query.codigo) });
  res.json({ encontrado: true, codigo: p.codigo, descripcion: p.descripcion, categoria: p.categoria });
}));

// Autocompletado por código o descripción (captura manual)
r.get('/productos/sugerir', ah((req, res) => {
  const inv = req.query.inventario_id ? obtenerInventario(req.query.inventario_id) : inventarioActivo();
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const palabras = q.split(/\s+/).slice(0, 5);
  const cond = palabras.map(() => '(codigo LIKE ? OR descripcion LIKE ?)').join(' AND ');
  const args = palabras.flatMap((w) => [`%${w}%`, `%${w}%`]);
  res.json(db.prepare(`SELECT codigo, descripcion FROM productos WHERE inventario_id = ? AND ${cond}
    ORDER BY (codigo = ?) DESC, (codigo LIKE ?) DESC, descripcion LIMIT 25`).all(inv.id, ...args, q, `${q}%`));
}));

module.exports = r;
