// Captura de conteos (móvil) y concentrado/edición (auditor)
const express = require('express');
const { db, bitacora } = require('../db');
const { requiereRol, HttpError, esAuditor } = require('../auth');
const { ah, aNumero, normalizarCodigo, obtenerInventario, inventarioActivo, exigirAbierto, resolverProducto } = require('../util');

const r = express.Router();

function validarCantidad(v) {
  const n = aNumero(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'Cantidad inválida');
  if (n < 0) throw new HttpError(400, 'La cantidad no puede ser negativa');
  if (n > 1e9) throw new HttpError(400, 'Cantidad fuera de rango');
  return n;
}

const SELECT_CONTEO = `
  SELECT c.id, c.inventario_id, c.codigo, c.codigo_leido, c.cantidad, c.usuario_id, u.nombre usuario_nombre,
         c.dispositivo_id, c.dispositivo_nombre, c.ubicacion, c.origen, c.creado, c.modificado,
         m.nombre modificado_por_nombre, c.eliminado, p.descripcion, (p.id IS NULL) no_catalogado
  FROM conteos c
  JOIN usuarios u ON u.id = c.usuario_id
  LEFT JOIN usuarios m ON m.id = c.modificado_por
  LEFT JOIN productos p ON p.inventario_id = c.inventario_id AND p.codigo = c.codigo`;

function insertarConteo(req, inv, { codigo, cantidad, ubicacion, client_uuid, origen, usuario_id }) {
  const leido = normalizarCodigo(codigo);
  if (!leido) throw new HttpError(400, 'Código vacío');
  const cant = validarCantidad(cantidad);
  if (client_uuid) {
    const ya = db.prepare('SELECT id FROM conteos WHERE client_uuid = ?').get(String(client_uuid));
    if (ya) return { id: ya.id, duplicado: true };
  }
  const p = resolverProducto(inv.id, leido);
  const x = db.prepare(`INSERT INTO conteos(inventario_id, codigo, codigo_leido, cantidad, usuario_id, dispositivo_id, dispositivo_nombre, ubicacion, origen, client_uuid)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(inv.id, p ? p.codigo : leido, leido, cant, usuario_id ?? req.user.id,
    req.sesion.dispositivo_id, req.sesion.dispositivo_nombre, ubicacion || null, origen, client_uuid || null);
  return { id: x.lastInsertRowid, codigo: p ? p.codigo : leido, descripcion: p?.descripcion ?? null, no_catalogado: !p };
}

// ---- Móvil ----
r.post('/conteos', ah((req, res) => {
  const inv = req.body?.inventario_id ? obtenerInventario(req.body.inventario_id) : inventarioActivo();
  exigirAbierto(inv);
  const out = insertarConteo(req, inv, { ...req.body, origen: 'movil', usuario_id: req.user.id });
  if (!out.duplicado) bitacora(req, 'conteo_crear', { inventario_id: inv.id, entidad: 'conteo', entidad_id: out.id, detalle: { codigo: out.codigo, cantidad: req.body.cantidad } });
  res.json(out);
}));

r.get('/conteos/mios', ah((req, res) => {
  const inv = inventarioActivo();
  const rows = db.prepare(`${SELECT_CONTEO} WHERE c.inventario_id = ? AND c.usuario_id = ? AND c.eliminado = 0 ORDER BY c.id DESC LIMIT ?`)
    .all(inv.id, req.user.id, Math.min(Number(req.query.limite) || 300, 2000));
  const tot = db.prepare('SELECT COUNT(*) registros, COALESCE(SUM(cantidad),0) piezas, COUNT(DISTINCT codigo) articulos FROM conteos WHERE inventario_id = ? AND usuario_id = ? AND eliminado = 0')
    .get(inv.id, req.user.id);
  res.json({ inventario: { id: inv.id, nombre: inv.nombre, estado: inv.estado }, totales: tot, conteos: rows });
}));

// Editar: el dueño puede cambiar la cantidad de sus propios conteos; el auditor cualquier campo de cualquiera
r.put('/conteos/:id', ah((req, res) => {
  const c = db.prepare('SELECT * FROM conteos WHERE id = ? AND eliminado = 0').get(Number(req.params.id));
  if (!c) throw new HttpError(404, 'Conteo no encontrado');
  const auditor = esAuditor(req.user);
  if (!auditor && c.usuario_id !== req.user.id) throw new HttpError(403, 'Sólo puede editar sus propios conteos');
  const inv = obtenerInventario(c.inventario_id);
  exigirAbierto(inv);
  const cambios = {};
  if (req.body.cantidad != null) cambios.cantidad = validarCantidad(req.body.cantidad);
  if (auditor && req.body.codigo != null && normalizarCodigo(req.body.codigo) !== c.codigo) {
    const leido = normalizarCodigo(req.body.codigo);
    if (!leido) throw new HttpError(400, 'Código vacío');
    const p = resolverProducto(inv.id, leido);
    cambios.codigo = p ? p.codigo : leido;
    cambios.codigo_leido = leido;
  }
  if (auditor && req.body.ubicacion !== undefined) cambios.ubicacion = req.body.ubicacion || null;
  if (!Object.keys(cambios).length) return res.json({ ok: true });
  const sets = Object.keys(cambios).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE conteos SET ${sets}, modificado = strftime('%Y-%m-%dT%H:%M:%fZ','now'), modificado_por = ? WHERE id = ?`)
    .run(...Object.values(cambios), req.user.id, c.id);
  const antes = Object.fromEntries(Object.keys(cambios).map((k) => [k, c[k]]));
  bitacora(req, 'conteo_editar', { inventario_id: inv.id, entidad: 'conteo', entidad_id: c.id, detalle: { antes, despues: cambios } });
  res.json({ ok: true });
}));

// ---- Auditor ----
r.delete('/conteos/:id', requiereRol('auditor'), ah((req, res) => {
  const c = db.prepare('SELECT * FROM conteos WHERE id = ? AND eliminado = 0').get(Number(req.params.id));
  if (!c) throw new HttpError(404, 'Conteo no encontrado');
  exigirAbierto(obtenerInventario(c.inventario_id));
  db.prepare(`UPDATE conteos SET eliminado = 1, modificado = strftime('%Y-%m-%dT%H:%M:%fZ','now'), modificado_por = ? WHERE id = ?`).run(req.user.id, c.id);
  bitacora(req, 'conteo_eliminar', { inventario_id: c.inventario_id, entidad: 'conteo', entidad_id: c.id, detalle: { codigo: c.codigo, cantidad: c.cantidad, usuario_id: c.usuario_id } });
  res.json({ ok: true });
}));

r.get('/inventarios/:id/conteos', requiereRol('auditor'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  const cond = ['c.inventario_id = ?'];
  const args = [inv.id];
  if (req.query.eliminados !== '1') cond.push('c.eliminado = 0');
  if (req.query.codigo) { cond.push('c.codigo = ?'); args.push(normalizarCodigo(req.query.codigo)); }
  if (req.query.desde_id) { cond.push('c.id > ?'); args.push(Number(req.query.desde_id)); }
  const rows = db.prepare(`${SELECT_CONTEO} WHERE ${cond.join(' AND ')} ORDER BY c.id DESC`).all(...args);
  res.json(rows);
}));

r.post('/inventarios/:id/conteos', requiereRol('auditor'), ah((req, res) => {
  const inv = obtenerInventario(req.params.id);
  exigirAbierto(inv);
  let usuario_id = req.user.id;
  if (req.body.usuario_id) {
    const u = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(Number(req.body.usuario_id));
    if (!u) throw new HttpError(400, 'Usuario inválido');
    usuario_id = u.id;
  }
  const out = insertarConteo(req, inv, { ...req.body, origen: 'auditor', usuario_id });
  bitacora(req, 'conteo_agregar_auditor', { inventario_id: inv.id, entidad: 'conteo', entidad_id: out.id, detalle: { codigo: out.codigo, cantidad: req.body.cantidad, a_nombre_de: usuario_id } });
  res.json(out);
}));

module.exports = r;
