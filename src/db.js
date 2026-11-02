// Conexión SQLite y migraciones versionadas.
// Para agregar funcionalidades (ubicaciones, categorías, etc.) agrega una
// nueva entrada al final de MIGRACIONES; nunca modifiques las ya existentes.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'inventario.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRACIONES = [
  // 1: esquema base
  `
  CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY,
    usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nombre TEXT NOT NULL,
    rol TEXT NOT NULL CHECK (rol IN ('contador','auditor','admin')),
    pass_hash TEXT NOT NULL,
    activo INTEGER NOT NULL DEFAULT 1,
    creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    dispositivo_id TEXT,
    dispositivo_nombre TEXT,
    tipo TEXT,
    ip TEXT,
    creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ultimo TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE config (clave TEXT PRIMARY KEY, valor TEXT);
  CREATE TABLE inventarios (
    id INTEGER PRIMARY KEY,
    nombre TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','cerrado')),
    notas TEXT,
    stock_archivo TEXT,
    stock_cargado TEXT,
    creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    cerrado TEXT
  );
  CREATE TABLE productos (
    id INTEGER PRIMARY KEY,
    inventario_id INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE,
    codigo TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    precio_vta REAL NOT NULL DEFAULT 0,
    costo REAL NOT NULL DEFAULT 0,
    cantidad REAL NOT NULL DEFAULT 0,
    categoria TEXT,
    ubicacion TEXT,
    extra TEXT,
    UNIQUE (inventario_id, codigo)
  );
  CREATE TABLE codigos_alternos (
    inventario_id INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE,
    alterno TEXT NOT NULL,
    codigo TEXT NOT NULL,
    PRIMARY KEY (inventario_id, alterno)
  );
  CREATE TABLE conteos (
    id INTEGER PRIMARY KEY,
    inventario_id INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE,
    codigo TEXT NOT NULL,
    codigo_leido TEXT,
    cantidad REAL NOT NULL,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    dispositivo_id TEXT,
    dispositivo_nombre TEXT,
    ubicacion TEXT,
    origen TEXT NOT NULL DEFAULT 'movil',
    client_uuid TEXT UNIQUE,
    creado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    modificado TEXT,
    modificado_por INTEGER REFERENCES usuarios(id),
    eliminado INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_conteos_inv_codigo ON conteos(inventario_id, codigo);
  CREATE INDEX ix_conteos_usuario ON conteos(usuario_id);
  CREATE TABLE correcciones (
    inventario_id INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE,
    codigo TEXT NOT NULL,
    cantidad REAL NOT NULL,
    nota TEXT,
    usuario_id INTEGER REFERENCES usuarios(id),
    modificado TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (inventario_id, codigo)
  );
  CREATE TABLE bitacora (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    inventario_id INTEGER,
    usuario_id INTEGER,
    accion TEXT NOT NULL,
    entidad TEXT,
    entidad_id TEXT,
    detalle TEXT
  );
  CREATE INDEX ix_bitacora_inv ON bitacora(inventario_id, ts);
  `,
];

function migrar() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) v FROM schema_version').get();
  let actual = row?.v || 0;
  for (let i = actual; i < MIGRACIONES.length; i++) {
    transaccion(() => {
      db.exec(MIGRACIONES[i]);
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(i + 1);
    });
    console.log(`[db] migración ${i + 1} aplicada`);
  }
}

function transaccion(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pass), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarPassword(pass, almacenado) {
  const [salt, hash] = String(almacenado).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(pass), salt, 64);
  const esperado = Buffer.from(hash, 'hex');
  return esperado.length === calc.length && crypto.timingSafeEqual(calc, esperado);
}

function getConfig(clave, def = null) {
  const r = db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave);
  return r ? r.valor : def;
}
function setConfig(clave, valor) {
  db.prepare('INSERT INTO config(clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor')
    .run(clave, valor == null ? null : String(valor));
}

function bitacora(req, accion, { inventario_id = null, entidad = null, entidad_id = null, detalle = null } = {}) {
  db.prepare('INSERT INTO bitacora(inventario_id, usuario_id, accion, entidad, entidad_id, detalle) VALUES (?,?,?,?,?,?)')
    .run(inventario_id, req?.user?.id ?? null, accion, entidad, entidad_id == null ? null : String(entidad_id),
      detalle == null ? null : JSON.stringify(detalle));
}

function inicializar() {
  migrar();
  const n = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
  if (n === 0) {
    db.prepare('INSERT INTO usuarios(usuario, nombre, rol, pass_hash) VALUES (?,?,?,?)')
      .run('admin', 'Administrador', 'admin', hashPassword('admin'));
    console.log('[db] Usuario inicial creado: admin / admin  (cámbielo al entrar)');
  }
  if (!db.prepare('SELECT 1 FROM inventarios LIMIT 1').get()) {
    const r = db.prepare('INSERT INTO inventarios(nombre) VALUES (?)').run('Inventario inicial');
    setConfig('inventario_activo', r.lastInsertRowid);
  }
  if (getConfig('empresa') == null) setConfig('empresa', 'Mi Empresa');
}

module.exports = { db, transaccion, hashPassword, verificarPassword, getConfig, setConfig, bitacora, inicializar, DATA_DIR };
