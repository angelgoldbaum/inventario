// Autenticación, usuarios, dispositivos y configuración general
const express = require('express');
const { db, hashPassword, verificarPassword, getConfig, setConfig, bitacora } = require('../db');
const { autenticar, requiereRol, crearSesion, HttpError, ROLES, esAuditor } = require('../auth');
const { ah } = require('../util');

const r = express.Router();

r.post('/auth/login', ah((req, res) => {
  const { usuario, password, dispositivo_id, dispositivo_nombre, tipo } = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(String(usuario || '').trim());
  if (!u || !u.activo || !verificarPassword(password || '', u.pass_hash)) throw new HttpError(401, 'Usuario o contraseña incorrectos');
  if (tipo === 'pc' && !esAuditor(u)) throw new HttpError(403, 'El panel de PC es sólo para auditores/administradores');
  const token = crearSesion(u, { dispositivo_id, dispositivo_nombre, tipo, ip: req.ip });
  bitacora({ user: u }, 'login', { detalle: { dispositivo_nombre, tipo } });
  res.json({ token, usuario: { id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol }, debe_cambiar: u.usuario === 'admin' && verificarPassword('admin', u.pass_hash) });
}));

r.use(autenticar);

r.post('/auth/logout', ah((req, res) => {
  db.prepare('DELETE FROM sesiones WHERE token = ?').run(req.sesion.token);
  res.json({ ok: true });
}));

r.get('/auth/yo', ah((req, res) => res.json({ usuario: req.user, sesion: { dispositivo_nombre: req.sesion.dispositivo_nombre } })));

r.put('/auth/password', ah((req, res) => {
  const { actual, nueva } = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!verificarPassword(actual || '', u.pass_hash)) throw new HttpError(400, 'La contraseña actual no coincide');
  if (!nueva || String(nueva).length < 4) throw new HttpError(400, 'La nueva contraseña debe tener al menos 4 caracteres');
  db.prepare('UPDATE usuarios SET pass_hash = ? WHERE id = ?').run(hashPassword(nueva), u.id);
  res.json({ ok: true });
}));

// ---- Usuarios ----
r.get('/usuarios', requiereRol('auditor'), ah((req, res) => {
  res.json(db.prepare('SELECT id, usuario, nombre, rol, activo, creado FROM usuarios ORDER BY nombre').all());
}));

r.post('/usuarios', requiereRol('admin'), ah((req, res) => {
  const { usuario, nombre, rol, password } = req.body || {};
  if (!usuario || !nombre || !password) throw new HttpError(400, 'Usuario, nombre y contraseña son obligatorios');
  if (!ROLES[rol]) throw new HttpError(400, 'Rol inválido');
  if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario.trim())) throw new HttpError(409, 'Ese usuario ya existe');
  const x = db.prepare('INSERT INTO usuarios(usuario, nombre, rol, pass_hash) VALUES (?,?,?,?)')
    .run(usuario.trim(), nombre.trim(), rol, hashPassword(password));
  bitacora(req, 'usuario_crear', { entidad: 'usuario', entidad_id: x.lastInsertRowid, detalle: { usuario, rol } });
  res.json({ id: x.lastInsertRowid });
}));

r.put('/usuarios/:id', requiereRol('admin'), ah((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Usuario no encontrado');
  const { nombre, rol, activo, password } = req.body || {};
  if (rol && !ROLES[rol]) throw new HttpError(400, 'Rol inválido');
  if (id === req.user.id && (activo === false || (rol && rol !== 'admin'))) throw new HttpError(400, 'No puede desactivarse ni quitarse el rol de administrador a sí mismo');
  db.prepare('UPDATE usuarios SET nombre = ?, rol = ?, activo = ? WHERE id = ?')
    .run(nombre ?? u.nombre, rol ?? u.rol, activo == null ? u.activo : (activo ? 1 : 0), id);
  if (password) db.prepare('UPDATE usuarios SET pass_hash = ? WHERE id = ?').run(hashPassword(password), id);
  if (activo === false) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
  bitacora(req, 'usuario_editar', { entidad: 'usuario', entidad_id: id, detalle: { nombre, rol, activo, password: password ? '***' : undefined } });
  res.json({ ok: true });
}));

// ---- Dispositivos / sesiones ----
r.get('/sesiones', requiereRol('auditor'), ah((req, res) => {
  res.json(db.prepare(`
    SELECT s.dispositivo_id, s.dispositivo_nombre, s.tipo, s.ip, s.creado, s.ultimo, u.nombre, u.usuario, u.rol,
      (SELECT COUNT(*) FROM conteos c WHERE c.dispositivo_id = s.dispositivo_id AND c.usuario_id = s.usuario_id AND c.eliminado = 0) conteos
    FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.ultimo > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')
    ORDER BY s.ultimo DESC`).all());
}));

r.delete('/sesiones/dispositivo/:dispositivo_id', requiereRol('auditor'), ah((req, res) => {
  db.prepare('DELETE FROM sesiones WHERE dispositivo_id = ?').run(req.params.dispositivo_id);
  res.json({ ok: true });
}));

// ---- Configuración ----
r.get('/config', ah((req, res) => {
  res.json({ empresa: getConfig('empresa'), inventario_activo: Number(getConfig('inventario_activo')) || null });
}));

r.put('/config', requiereRol('admin'), ah((req, res) => {
  if (req.body?.empresa != null) setConfig('empresa', String(req.body.empresa).slice(0, 120));
  res.json({ ok: true });
}));

module.exports = r;
