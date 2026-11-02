const crypto = require('node:crypto');
const { db } = require('./db');

const ROLES = { contador: 1, auditor: 2, admin: 3 };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function crearSesion(usuario, { dispositivo_id, dispositivo_nombre, tipo, ip }) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesiones(token, usuario_id, dispositivo_id, dispositivo_nombre, tipo, ip) VALUES (?,?,?,?,?,?)')
    .run(token, usuario.id, dispositivo_id || null, dispositivo_nombre || null, tipo || null, ip || null);
  return token;
}

const stmtSesion = db.prepare(`
  SELECT s.token, s.dispositivo_id, s.dispositivo_nombre, s.tipo, s.ultimo,
         u.id, u.usuario, u.nombre, u.rol, u.activo
  FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ?`);
const stmtTocar = db.prepare(`UPDATE sesiones SET ultimo = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token = ?`);

// Middleware: carga req.user y req.sesion a partir del header Authorization: Bearer <token>
function autenticar(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Sesión requerida'));
  const s = stmtSesion.get(token);
  if (!s || !s.activo) return next(new HttpError(401, 'Sesión inválida o expirada'));
  // actualiza "última actividad" como máximo cada 30 s
  if (Date.now() - Date.parse(s.ultimo) > 30000) stmtTocar.run(token);
  req.user = { id: s.id, usuario: s.usuario, nombre: s.nombre, rol: s.rol };
  req.sesion = { token, dispositivo_id: s.dispositivo_id, dispositivo_nombre: s.dispositivo_nombre, tipo: s.tipo };
  next();
}

// requiere un rol mínimo (contador < auditor < admin)
function requiereRol(minimo) {
  return (req, res, next) => {
    if (!req.user || ROLES[req.user.rol] < ROLES[minimo]) return next(new HttpError(403, 'No autorizado'));
    next();
  };
}

const esAuditor = (user) => ROLES[user.rol] >= ROLES.auditor;

module.exports = { autenticar, requiereRol, crearSesion, esAuditor, HttpError, ROLES };
