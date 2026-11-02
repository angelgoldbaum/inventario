// Totalización, comparación contra stock teórico, correcciones, exportaciones y bitácora
const express = require('express');
const XLSX = require('xlsx');
const { db, getConfig, bitacora } = require('../db');
const { requiereRol, HttpError } = require('../auth');
const { ah, aNumero, normalizarCodigo, obtenerInventario, exigirAbierto } = require('../util');

const r = express.Router();
r.use(requiereRol('auditor'));

const redondear = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// Calcula el comparativo por artículo. Es la base de la pestaña Revisión y de todos los reportes.
function calcularRevision(inventario_id) {
  const rows = db.prepare(`
    WITH c AS (
      SELECT c.codigo, SUM(c.cantidad) contado, COUNT(*) registros, MAX(c.creado) ultimo,
             GROUP_CONCAT(DISTINCT u.nombre) contadores
      FROM conteos c JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.inventario_id = ? AND c.eliminado = 0 GROUP BY c.codigo),
    k AS (
      SELECT codigo FROM productos WHERE inventario_id = ?
      UNION SELECT codigo FROM c
      UNION SELECT codigo FROM correcciones WHERE inventario_id = ?)
    SELECT k.codigo, p.descripcion, p.categoria, p.ubicacion,
           COALESCE(p.precio_vta, 0) precio_vta, COALESCE(p.costo, 0) costo, COALESCE(p.cantidad, 0) teorico,
           (p.id IS NULL) no_catalogado, c.contado, COALESCE(c.registros, 0) registros, c.ultimo, c.contadores,
           r.cantidad correccion, r.nota correccion_nota, r.modificado correccion_fecha, ru.nombre correccion_usuario
    FROM k
    LEFT JOIN productos p ON p.inventario_id = ? AND p.codigo = k.codigo
    LEFT JOIN c ON c.codigo = k.codigo
    LEFT JOIN correcciones r ON r.inventario_id = ? AND r.codigo = k.codigo
    LEFT JOIN usuarios ru ON ru.id = r.usuario_id
    ORDER BY k.codigo`).all(inventario_id, inventario_id, inventario_id, inventario_id, inventario_id);

  return rows.map((x) => {
    const contado = x.contado == null ? null : redondear(x.contado);
    const final = x.correccion != null ? x.correccion : (contado ?? 0);
    const dif = redondear(final - x.teorico);
    let estado = 'ok';
    if (x.no_catalogado) estado = 'no_catalogado';
    else if (dif < 0) estado = 'faltante';
    else if (dif > 0) estado = 'sobrante';
    return {
      ...x,
      no_catalogado: !!x.no_catalogado,
      contado,
      sin_contar: x.contado == null,
      final,
      diferencia: dif,
      dif_costo: redondear(dif * x.costo, 2),
      dif_venta: redondear(dif * x.precio_vta, 2),
      valor_teorico: redondear(x.teorico * x.costo, 2),
      valor_final: redondear(final * x.costo, 2),
      estado,
    };
  });
}

function resumen(filas) {
  const s = { articulos: filas.length, contados: 0, sin_contar: 0, con_diferencia: 0, faltantes: 0, sobrantes: 0, no_catalogados: 0, corregidos: 0,
    piezas_teorico: 0, piezas_final: 0, piezas_faltantes: 0, piezas_sobrantes: 0,
    valor_teorico: 0, valor_final: 0, costo_faltante: 0, costo_sobrante: 0, venta_faltante: 0, venta_sobrante: 0 };
  for (const f of filas) {
    if (!f.sin_contar) s.contados++; else s.sin_contar++;
    if (f.correccion != null) s.corregidos++;
    if (f.no_catalogado) s.no_catalogados++;
    if (f.diferencia !== 0) s.con_diferencia++;
    if (f.diferencia < 0) { s.faltantes++; s.piezas_faltantes += f.diferencia; s.costo_faltante += f.dif_costo; s.venta_faltante += f.dif_venta; }
    if (f.diferencia > 0) { s.sobrantes++; s.piezas_sobrantes += f.diferencia; s.costo_sobrante += f.dif_costo; s.venta_sobrante += f.dif_venta; }
    s.piezas_teorico += f.teorico; s.piezas_final += f.final; s.valor_teorico += f.valor_teorico; s.valor_final += f.valor_final;
  }
  for (const k of Object.keys(s)) s[k] = redondear(s[k], 2);
  s.costo_neto = redondear(s.costo_faltante + s.costo_sobrante, 2);
  s.venta_neta = redondear(s.venta_faltante + s.venta_sobrante, 2);
  return s;
}

r.get('/inventarios/:id/revision', ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  const filas = calcularRevision(inv.id);
  res.json({ inventario: inv, empresa: getConfig('empresa'), generado: new Date().toISOString(), resumen: resumen(filas), filas });
}));

// Corrección manual (cantidad definitiva) por artículo. cantidad null/'' => elimina la corrección
r.put('/inventarios/:id/correcciones/:codigo', ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  exigirAbierto(inv);
  const codigo = normalizarCodigo(req.params.codigo);
  const previo = db.prepare('SELECT cantidad, nota FROM correcciones WHERE inventario_id = ? AND codigo = ?').get(inv.id, codigo);
  const v = req.body?.cantidad;
  if (v == null || v === '') {
    db.prepare('DELETE FROM correcciones WHERE inventario_id = ? AND codigo = ?').run(inv.id, codigo);
    bitacora(req, 'correccion_quitar', { inventario_id: inv.id, entidad: 'correccion', entidad_id: codigo, detalle: { antes: previo } });
    return res.json({ ok: true });
  }
  const n = aNumero(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'Cantidad inválida');
  db.prepare(`INSERT INTO correcciones(inventario_id, codigo, cantidad, nota, usuario_id) VALUES (?,?,?,?,?)
    ON CONFLICT(inventario_id, codigo) DO UPDATE SET cantidad = excluded.cantidad, nota = COALESCE(excluded.nota, nota),
      usuario_id = excluded.usuario_id, modificado = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(inv.id, codigo, n, req.body?.nota ?? null, req.user.id);
  bitacora(req, 'correccion_fijar', { inventario_id: inv.id, entidad: 'correccion', entidad_id: codigo, detalle: { antes: previo, cantidad: n, nota: req.body?.nota } });
  res.json({ ok: true });
}));

// ---- Exportaciones a Excel ----
function enviarXlsx(res, nombre, hojas) {
  const wb = XLSX.utils.book_new();
  for (const [titulo, filas] of hojas) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), titulo.slice(0, 31));
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

const nombreArchivo = (inv, tipo) => `${tipo}-${inv.nombre.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.xlsx`;

r.get('/inventarios/:id/export/revision.xlsx', ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  const filas = calcularRevision(inv.id).map((f) => ({
    CODIGO: f.codigo, DESCRIPCION: f.descripcion ?? '(no catalogado)', CATEGORIA: f.categoria ?? '', 'PRECIO VTA': f.precio_vta, COSTO: f.costo,
    TEORICO: f.teorico, CONTADO: f.contado ?? '', CORRECCION: f.correccion ?? '', FINAL: f.final, DIFERENCIA: f.diferencia,
    'DIF $ COSTO': f.dif_costo, 'DIF $ VENTA': f.dif_venta, ESTADO: f.estado, REGISTROS: f.registros, CONTADORES: f.contadores ?? '',
  }));
  enviarXlsx(res, nombreArchivo(inv, 'revision'), [['Revision', filas]]);
}));

// Archivo de ajuste: sólo artículos con diferencia; columnas listas para importar al sistema
r.get('/inventarios/:id/export/ajuste.xlsx', ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  const filas = calcularRevision(inv.id).filter((f) => f.diferencia !== 0).map((f) => ({
    CODIGO: f.codigo, DESCRIPCION: f.descripcion ?? '(no catalogado)', 'CANTIDAD SISTEMA': f.teorico, 'CANTIDAD FISICA': f.final,
    AJUSTE: f.diferencia, TIPO: f.diferencia > 0 ? 'ENTRADA' : 'SALIDA', COSTO: f.costo, IMPORTE: f.dif_costo,
  }));
  const fisico = calcularRevision(inv.id).map((f) => ({ CODIGO: f.codigo, DESCRIPCION: f.descripcion ?? '', CANTIDAD: f.final }));
  enviarXlsx(res, nombreArchivo(inv, 'ajuste'), [['Ajuste', filas], ['Inventario fisico', fisico]]);
}));

r.get('/inventarios/:id/export/conteos.xlsx', ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  const filas = db.prepare(`
    SELECT c.id ID, c.codigo CODIGO, c.codigo_leido "CODIGO LEIDO", p.descripcion DESCRIPCION, c.cantidad CANTIDAD,
           u.nombre CONTADOR, c.dispositivo_nombre DISPOSITIVO, c.origen ORIGEN, c.creado FECHA, c.modificado MODIFICADO,
           CASE c.eliminado WHEN 1 THEN 'SI' ELSE '' END ELIMINADO
    FROM conteos c JOIN usuarios u ON u.id = c.usuario_id
    LEFT JOIN productos p ON p.inventario_id = c.inventario_id AND p.codigo = c.codigo
    WHERE c.inventario_id = ? ORDER BY c.id`).all(inv.id);
  enviarXlsx(res, nombreArchivo(inv, 'conteos'), [['Conteos', filas]]);
}));

// ---- Bitácora ----
r.get('/inventarios/:id/bitacora', ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  res.json(db.prepare(`SELECT b.id, b.ts, b.accion, b.entidad, b.entidad_id, b.detalle, u.nombre usuario
    FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
    WHERE b.inventario_id = ? ORDER BY b.id DESC LIMIT 1000`).all(inv.id));
}));

module.exports = r;
module.exports.calcularRevision = calcularRevision;
