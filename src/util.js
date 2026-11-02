const { db, getConfig } = require('./db');
const { HttpError } = require('./auth');

// Convierte "1,234.50", "$ 12", "12,5" (coma decimal) a número
function aNumero(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[$\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.'); // formato 1.234,56
  } else {
    s = s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// "Precio Vta." -> "PRECIO VTA" ; quita acentos y puntuación
function normalizarEncabezado(h) {
  return String(h).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function normalizarCodigo(c) {
  return String(c ?? '').trim();
}

function obtenerInventario(id) {
  const inv = db.prepare('SELECT * FROM inventarios WHERE id = ?').get(Number(id));
  if (!inv) throw new HttpError(404, 'Inventario no encontrado');
  return inv;
}

function inventarioActivo() {
  const id = getConfig('inventario_activo');
  const inv = id && db.prepare('SELECT * FROM inventarios WHERE id = ?').get(Number(id));
  if (!inv) throw new HttpError(409, 'No hay un inventario activo. Pida al auditor que active uno.');
  return inv;
}

function exigirAbierto(inv) {
  if (inv.estado !== 'abierto') throw new HttpError(409, `El inventario "${inv.nombre}" está cerrado`);
}

// Resuelve un código leído (código principal o código alterno/de barras)
const stmtProd = db.prepare('SELECT * FROM productos WHERE inventario_id = ? AND codigo = ?');
const stmtAlt = db.prepare('SELECT codigo FROM codigos_alternos WHERE inventario_id = ? AND alterno = ?');
function resolverProducto(inventario_id, leido) {
  const c = normalizarCodigo(leido);
  let p = stmtProd.get(inventario_id, c);
  if (!p) {
    const a = stmtAlt.get(inventario_id, c);
    if (a) p = stmtProd.get(inventario_id, a.codigo);
  }
  // códigos numéricos con ceros a la izquierda (Excel suele quitarlos)
  if (!p && /^0+\d+$/.test(c)) p = stmtProd.get(inventario_id, c.replace(/^0+/, ''));
  return p || null;
}

const ah = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) { next(e); }
};

module.exports = { aNumero, normalizarEncabezado, normalizarCodigo, obtenerInventario, inventarioActivo, exigirAbierto, resolverProducto, ah };
