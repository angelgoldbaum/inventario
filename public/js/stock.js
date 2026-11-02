// Lectura del archivo de stock teórico (.xlsx, .xls, .csv) en el navegador con SheetJS (global XLSX)

// Columnas reconocidas y sus alias. Para soportar nuevas columnas agréguelas aquí;
// lo no reconocido se conserva en "extra".
export const COLUMNAS = {
  codigo: { req: true, alias: ['CODIGO', 'SKU', 'CLAVE', 'COD'] },
  descripcion: { req: true, alias: ['DESCRIPCION', 'DESC', 'ARTICULO', 'PRODUCTO'] },
  precio_vta: { req: true, alias: ['PRECIO VTA', 'PRECIO VENTA', 'PRECIO', 'PVTA', 'P VTA'] },
  costo: { req: true, alias: ['COSTO', 'COSTO UNITARIO', 'COSTO UNIT'] },
  cantidad: { req: true, alias: ['CANTIDAD', 'EXISTENCIA', 'STOCK', 'CANT'] },
  categoria: { req: false, alias: ['CATEGORIA', 'LINEA', 'FAMILIA', 'DEPARTAMENTO'] },
  ubicacion: { req: false, alias: ['UBICACION', 'ALMACEN', 'PASILLO'] },
  codigo_barras: { req: false, alias: ['CODIGO BARRAS', 'CODIGO DE BARRAS', 'CODIGOS BARRAS', 'EAN', 'UPC', 'CODIGO ALTERNO'] },
};

export function aNumero(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/[$\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) || /^-?\d+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const normalizar = (h) => String(h).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const codigo = (v) => String(v ?? '').trim();

export async function leerArchivoStock(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', codepage: 65001 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  let idxEnc = -1; let mapa = null;
  for (let i = 0; i < Math.min(20, filas.length); i++) {
    const enc = filas[i].map(normalizar);
    const m = {};
    for (const [campo, def] of Object.entries(COLUMNAS)) {
      const j = enc.findIndex((h) => def.alias.includes(h));
      if (j >= 0) m[campo] = j;
    }
    if (m.codigo != null && m.cantidad != null) { idxEnc = i; mapa = m; break; }
  }
  if (idxEnc < 0) throw new Error('No se encontraron los encabezados. Columnas esperadas: CODIGO, DESCRIPCION, PRECIO VTA, COSTO, CANTIDAD');
  const faltan = Object.entries(COLUMNAS).filter(([k, d]) => d.req && mapa[k] == null).map(([, d]) => d.alias[0]);
  if (faltan.length) throw new Error(`Faltan columnas: ${faltan.join(', ')}`);

  const encOriginal = filas[idxEnc];
  const usadas = new Set(Object.values(mapa));
  const productos = new Map();
  const advertencias = [];
  let alternos = 0;
  filas.slice(idxEnc + 1).forEach((f, i) => {
    const nFila = idxEnc + 2 + i;
    const cod = codigo(f[mapa.codigo]);
    if (!cod) { if (f.some((v) => v !== '')) advertencias.push(`Fila ${nFila}: sin código, se omitió`); return; }
    const p = {
      codigo: cod,
      descripcion: String(f[mapa.descripcion] ?? '').trim(),
      precio_vta: aNumero(f[mapa.precio_vta]),
      costo: aNumero(f[mapa.costo]),
      cantidad: aNumero(f[mapa.cantidad]),
      categoria: mapa.categoria != null ? String(f[mapa.categoria] ?? '').trim() || null : null,
      ubicacion: mapa.ubicacion != null ? String(f[mapa.ubicacion] ?? '').trim() || null : null,
      alternos: [],
      extra: null,
    };
    for (const k of ['precio_vta', 'costo', 'cantidad']) {
      if (Number.isNaN(p[k])) { advertencias.push(`Fila ${nFila} (${cod}): ${k.toUpperCase()} no numérico, se tomó 0`); p[k] = 0; }
    }
    const extra = {};
    encOriginal.forEach((h, j) => { if (!usadas.has(j) && h !== '' && f[j] !== '') extra[String(h)] = f[j]; });
    if (Object.keys(extra).length) p.extra = extra;
    if (mapa.codigo_barras != null) {
      p.alternos = String(f[mapa.codigo_barras] ?? '').split(/[,;|\s]+/).map(codigo).filter((x) => x && x !== cod);
    }
    if (productos.has(cod)) {
      const prev = productos.get(cod);
      prev.cantidad += p.cantidad;
      prev.alternos = [...new Set([...prev.alternos, ...p.alternos])];
      advertencias.push(`Fila ${nFila}: código ${cod} duplicado, se sumaron las cantidades`);
    } else productos.set(cod, p);
  });
  for (const p of productos.values()) alternos += p.alternos.length;
  if (!productos.size) throw new Error('El archivo no contiene artículos');
  return { productos: [...productos.values()], advertencias, alternos };
}

export function descargarPlantilla() {
  const ws = XLSX.utils.aoa_to_sheet([
    ['CODIGO', 'DESCRIPCION', 'PRECIO VTA', 'COSTO', 'CANTIDAD', 'CATEGORIA', 'CODIGO BARRAS'],
    ['A001', 'Artículo de ejemplo', 25.5, 15.2, 10, 'General', '7501234567890'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  XLSX.writeFile(wb, 'plantilla-stock.xlsx');
}

export function exportarXlsx(nombre, hojas) {
  const wb = XLSX.utils.book_new();
  for (const [titulo, filas] of hojas) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas.length ? filas : [{}]), titulo.slice(0, 31));
  XLSX.writeFile(wb, nombre);
}
