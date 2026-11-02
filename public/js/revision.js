// Totalización de conteos y comparación contra el stock teórico.
// Es la base de la pestaña Revisión, de los reportes y de las exportaciones.
export const r2 = (n) => Math.round(n * 100) / 100;
export const r4 = (n) => Math.round(n * 1e4) / 1e4;

export function recalcular(f) {
  f.final = f.correccion != null ? f.correccion : (f.contado ?? 0);
  f.diferencia = r4(f.final - f.teorico);
  f.dif_costo = r2(f.diferencia * f.costo);
  f.dif_venta = r2(f.diferencia * f.precio_vta);
  f.valor_teorico = r2(f.teorico * f.costo);
  f.valor_final = r2(f.final * f.costo);
  f.estado = f.no_catalogado ? 'no_catalogado' : f.diferencia < 0 ? 'faltante' : f.diferencia > 0 ? 'sobrante' : 'ok';
  return f;
}

// catalogo: [{codigo, descripcion, precio_vta, costo, cantidad, categoria}]
// conteos:  [{codigo, cantidad, usuario_nombre, creado, eliminado}]
// correcciones: Map(codigo -> {cantidad, usuario_nombre, modificado})
export function calcularRevision(catalogo, conteos, correcciones) {
  const filas = new Map();
  const fila = (codigo, p) => ({
    codigo,
    descripcion: p?.descripcion ?? null,
    categoria: p?.categoria ?? null,
    ubicacion: p?.ubicacion ?? null,
    precio_vta: p?.precio_vta ?? 0,
    costo: p?.costo ?? 0,
    teorico: p?.cantidad ?? 0,
    no_catalogado: !p,
    contado: null,
    registros: 0,
    ultimo: null,
    _contadores: new Set(),
    correccion: null,
  });
  for (const p of catalogo) filas.set(p.codigo, fila(p.codigo, p));
  for (const c of conteos) {
    if (c.eliminado) continue;
    let f = filas.get(c.codigo);
    if (!f) { f = fila(c.codigo, null); filas.set(c.codigo, f); }
    f.contado = (f.contado ?? 0) + c.cantidad;
    f.registros++;
    f._contadores.add(c.usuario_nombre);
    if (!f.ultimo || c.creado > f.ultimo) f.ultimo = c.creado;
  }
  for (const [codigo, r] of correcciones) {
    let f = filas.get(codigo);
    if (!f) { f = fila(codigo, null); filas.set(codigo, f); }
    f.correccion = r.cantidad;
    f.correccion_usuario = r.usuario_nombre;
    f.correccion_fecha = r.modificado;
  }
  return [...filas.values()].map((f) => {
    f.contadores = [...f._contadores].join(', ');
    delete f._contadores;
    if (f.contado != null) f.contado = r4(f.contado);
    f.sin_contar = f.contado == null;
    return recalcular(f);
  });
}

export function resumen(filas) {
  const s = { articulos: filas.length, contados: 0, sin_contar: 0, con_diferencia: 0, faltantes: 0, sobrantes: 0, corregidos: 0, no_catalogados: 0,
    piezas_teorico: 0, piezas_final: 0, piezas_faltantes: 0, piezas_sobrantes: 0, valor_teorico: 0, valor_final: 0,
    costo_faltante: 0, costo_sobrante: 0, venta_faltante: 0, venta_sobrante: 0 };
  for (const f of filas) {
    f.sin_contar ? s.sin_contar++ : s.contados++;
    if (f.correccion != null) s.corregidos++;
    if (f.no_catalogado) s.no_catalogados++;
    if (f.diferencia) s.con_diferencia++;
    if (f.diferencia < 0) { s.faltantes++; s.costo_faltante += f.dif_costo; s.venta_faltante += f.dif_venta; s.piezas_faltantes += f.diferencia; }
    if (f.diferencia > 0) { s.sobrantes++; s.costo_sobrante += f.dif_costo; s.venta_sobrante += f.dif_venta; s.piezas_sobrantes += f.diferencia; }
    s.piezas_teorico += f.teorico; s.piezas_final += f.final; s.valor_teorico += f.valor_teorico; s.valor_final += f.valor_final;
  }
  s.costo_neto = s.costo_faltante + s.costo_sobrante;
  s.venta_neta = s.venta_faltante + s.venta_sobrante;
  return s;
}
