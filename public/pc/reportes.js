// Registro de reportes imprimibles.
// Para agregar un reporte nuevo basta con llamar a Reportes.registrar({...}) (en este archivo o en otro
// script incluido después). Cada reporte recibe el contexto de la revisión y devuelve HTML.
//   id, titulo, descripcion, formato: '80mm' | 'carta'
//   filtrar(filas)  -> filas a incluir (opcional)
//   generar(ctx)    -> HTML del cuerpo. ctx = { empresa, inventario, filas, resumen, usuario, fecha }
(function () {
  const { esc, num, dinero, fecha } = U;
  const lista = [];

  const CSS_BASE = `
    * { box-sizing: border-box; }
    body { margin: 0; color: #000; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    h1, h2, h3 { margin: 0; }
    .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .c { text-align: center; }
    .neg { font-weight: 700; }
    @media screen { body { background: #e5e5e5; } .hoja { background: #fff; margin: 12px auto; box-shadow: 0 0 8px rgba(0,0,0,.25); } .no-print { display: block; } }
    @media print { .no-print { display: none !important; } }
    .no-print { text-align: center; padding: 10px; font: 14px system-ui; }
    .no-print button { font-size: 15px; padding: 8px 18px; margin: 0 4px; cursor: pointer; }`;

  const CSS = {
    // Impresora térmica 80 mm (área imprimible ~72 mm)
    '80mm': `
      @page { size: 80mm auto; margin: 0; }
      .hoja { width: 80mm; padding: 3mm 4mm; font-size: 11.5px; line-height: 1.3; }
      .tc { text-align: center; }
      .tit { font-size: 14px; font-weight: 800; }
      .sep { border-top: 1px dashed #000; margin: 5px 0; }
      .sep2 { border-top: 2px solid #000; margin: 5px 0; }
      .it { padding: 3px 0; border-bottom: 1px dotted #777; break-inside: avoid; }
      .it .d { font-weight: 700; }
      .it .cod { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
      .g { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2px; }
      .g2 { display: grid; grid-template-columns: 1fr auto; gap: 2px; }
      .lbl { font-size: 9.5px; color: #000; text-transform: uppercase; }
      .linea { display: inline-block; border-bottom: 1px solid #000; width: 25mm; height: 14px; }
      .firma { margin-top: 14mm; border-top: 1px solid #000; text-align: center; font-size: 10px; padding-top: 2px; }`,
    // Hoja carta / A4
    carta: `
      @page { size: letter; margin: 12mm 10mm; }
      .hoja { width: 100%; max-width: 216mm; padding: 0; font-size: 10.5px; }
      @media screen { .hoja { padding: 12mm 10mm; } }
      .enc { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
      .enc h1 { font-size: 17px; } .enc .sub { font-size: 11px; }
      table { width: 100%; border-collapse: collapse; margin-top: 6px; }
      th, td { border-bottom: 1px solid #bbb; padding: 3px 4px; text-align: left; vertical-align: top; }
      th { background: #eee; font-size: 9.5px; text-transform: uppercase; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      tfoot td { font-weight: 700; border-top: 2px solid #000; }
      .seccion { margin-top: 14px; font-size: 13px; font-weight: 700; }
      .resumen { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 8px 0; }
      .resumen div { border: 1px solid #999; padding: 4px 6px; } .resumen span { display: block; font-size: 9px; text-transform: uppercase; }
      .resumen b { font-size: 13px; }
      .firmas { display: grid; grid-template-columns: repeat(3, 1fr); gap: 30px; margin-top: 40px; }
      .firmas div { border-top: 1px solid #000; text-align: center; padding-top: 3px; }`,
  };

  function imprimir(titulo, formato, cuerpo) {
    const w = window.open('', '_blank', formato === '80mm' ? 'width=420,height=800' : 'width=1000,height=800');
    if (!w) { U.toast('Permita ventanas emergentes para imprimir', 'error', 4000); return; }
    w.document.open();
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
      <style>${CSS_BASE}${CSS[formato] || CSS.carta}</style></head><body>
      <div class="no-print"><button onclick="window.print()">🖨 Imprimir</button><button onclick="window.close()">Cerrar</button></div>
      <div class="hoja">${cuerpo}</div>
      <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));<\/script></body></html>`);
    w.document.close();
  }

  // ---------- Bloques reutilizables ----------
  const encTicket = (ctx, titulo) => `
    <div class="tc"><div class="tit">${esc(ctx.empresa)}</div>
    <div><b>${esc(titulo)}</b></div>
    <div>${esc(ctx.inventario.nombre)}</div>
    <div>${esc(fecha(ctx.fecha))}</div>
    ${ctx.alcance ? `<div>${esc(ctx.alcance)}</div>` : ''}</div><div class="sep2"></div>`;

  const encCarta = (ctx, titulo) => `
    <div class="enc"><div><h1>${esc(titulo)}</h1><div class="sub">${esc(ctx.empresa)} — ${esc(ctx.inventario.nombre)}</div></div>
    <div class="sub" style="text-align:right">Emitido: ${esc(fecha(ctx.fecha))}<br>Por: ${esc(ctx.usuario?.nombre || '')}${ctx.alcance ? `<br>${esc(ctx.alcance)}` : ''}</div></div>`;

  const sumar = (filas, k) => filas.reduce((a, f) => a + (Number(f[k]) || 0), 0);
  const desc = (f) => f.descripcion || '(NO CATALOGADO)';

  // ---------- Reportes incluidos ----------
  registrar({
    id: 'dif-ticket',
    titulo: 'Diferencias (ticket 80mm)',
    descripcion: 'Lista de artículos con diferencia: teórico, contado, diferencia en piezas y monto. Ideal para revisión en piso.',
    formato: '80mm',
    filtrar: (f) => f.filter((x) => x.diferencia !== 0),
    generar(ctx) {
      const f = ctx.filas;
      return `${encTicket(ctx, 'REPORTE DE DIFERENCIAS')}
        ${f.map((x) => `<div class="it">
          <div class="cod">${esc(x.codigo)}</div><div class="d">${esc(desc(x))}</div>
          <div class="g"><div><span class="lbl">Teórico</span><br>${num(x.teorico)}</div>
            <div><span class="lbl">Físico</span><br>${num(x.final)}${x.correccion != null ? '*' : ''}</div>
            <div class="n"><span class="lbl">Dif</span><br><b>${x.diferencia > 0 ? '+' : ''}${num(x.diferencia)}</b></div></div>
          <div class="g2"><span class="lbl">Dif. costo</span><span class="n">${dinero(x.dif_costo)}</span></div>
        </div>`).join('')}
        <div class="sep2"></div>
        <div class="g2"><span>Artículos</span><b class="n">${num(f.length)}</b></div>
        <div class="g2"><span>Piezas faltantes</span><b class="n">${num(sumar(f.filter((x) => x.diferencia < 0), 'diferencia'))}</b></div>
        <div class="g2"><span>Piezas sobrantes</span><b class="n">+${num(sumar(f.filter((x) => x.diferencia > 0), 'diferencia'))}</b></div>
        <div class="g2"><span>Faltante $ costo</span><b class="n">${dinero(sumar(f.filter((x) => x.diferencia < 0), 'dif_costo'))}</b></div>
        <div class="g2"><span>Sobrante $ costo</span><b class="n">${dinero(sumar(f.filter((x) => x.diferencia > 0), 'dif_costo'))}</b></div>
        <div class="g2"><span>NETO $ costo</span><b class="n">${dinero(sumar(f, 'dif_costo'))}</b></div>
        <div class="g2"><span>NETO $ venta</span><b class="n">${dinero(sumar(f, 'dif_venta'))}</b></div>
        <div class="sep"></div><div class="tc" style="font-size:9.5px">* cantidad con corrección manual</div>
        <div class="firma">Revisó</div>`;
    },
  });

  registrar({
    id: 'reconteo-ticket',
    titulo: 'Hoja de reconteo (ticket 80mm)',
    descripcion: 'Artículos con diferencia o sin contar, SIN mostrar cantidades, con espacio para anotar el reconteo a ciegas.',
    formato: '80mm',
    filtrar: (f) => f.filter((x) => x.diferencia !== 0 && x.correccion == null),
    generar(ctx) {
      return `${encTicket(ctx, 'HOJA DE RECONTEO')}
        ${ctx.filas.map((x) => `<div class="it"><div class="cod">${esc(x.codigo)}</div><div class="d">${esc(desc(x))}</div>
          <div class="g2"><span>Cantidad:</span><span class="linea"></span></div></div>`).join('')}
        <div class="sep2"></div><div>Total artículos: <b>${num(ctx.filas.length)}</b></div>
        <div class="firma">Nombre y firma del contador</div>`;
    },
  });

  registrar({
    id: 'ajuste-carta',
    titulo: 'Reporte para modificación de inventario',
    descripcion: 'Documento formal de ajuste: entradas (sobrantes) y salidas (faltantes) con importes a costo, totales y firmas de autorización.',
    formato: 'carta',
    filtrar: (f) => f.filter((x) => x.diferencia !== 0),
    generar(ctx) {
      const entradas = ctx.filas.filter((x) => x.diferencia > 0);
      const salidas = ctx.filas.filter((x) => x.diferencia < 0);
      const tabla = (filas, titulo) => `
        <div class="seccion">${titulo} (${filas.length})</div>
        <table><thead><tr><th>Código</th><th>Descripción</th><th class="n">Sistema</th><th class="n">Físico</th><th class="n">Ajuste</th><th class="n">Costo unit.</th><th class="n">Importe costo</th><th class="n">Importe venta</th></tr></thead>
        <tbody>${filas.map((x) => `<tr><td>${esc(x.codigo)}</td><td>${esc(desc(x))}</td><td class="n">${num(x.teorico)}</td><td class="n">${num(x.final)}</td>
          <td class="n neg">${x.diferencia > 0 ? '+' : ''}${num(x.diferencia)}</td><td class="n">${dinero(x.costo)}</td><td class="n">${dinero(x.dif_costo)}</td><td class="n">${dinero(x.dif_venta)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total ${titulo.toLowerCase()}</td><td class="n">${num(sumar(filas, 'diferencia'))}</td><td></td><td class="n">${dinero(sumar(filas, 'dif_costo'))}</td><td class="n">${dinero(sumar(filas, 'dif_venta'))}</td></tr></tfoot></table>`;
      return `${encCarta(ctx, 'Ajuste de inventario')}
        <div class="resumen">
          <div><span>Artículos a ajustar</span><b>${num(ctx.filas.length)}</b></div>
          <div><span>Entradas (pzas / $)</span><b>+${num(sumar(entradas, 'diferencia'))}</b> / ${dinero(sumar(entradas, 'dif_costo'))}</div>
          <div><span>Salidas (pzas / $)</span><b>${num(sumar(salidas, 'diferencia'))}</b> / ${dinero(sumar(salidas, 'dif_costo'))}</div>
          <div><span>Ajuste neto a costo</span><b>${dinero(sumar(ctx.filas, 'dif_costo'))}</b></div>
        </div>
        ${entradas.length ? tabla(entradas, 'ENTRADAS') : ''}
        ${salidas.length ? tabla(salidas, 'SALIDAS') : ''}
        <div class="firmas"><div>Elaboró</div><div>Auditor</div><div>Autorizó</div></div>`;
    },
  });

  registrar({
    id: 'ajuste-ticket',
    titulo: 'Ajuste de inventario (ticket 80mm)',
    descripcion: 'Versión compacta del ajuste: código, ajuste en piezas e importe, con totales de entradas y salidas.',
    formato: '80mm',
    filtrar: (f) => f.filter((x) => x.diferencia !== 0),
    generar(ctx) {
      const linea = (x) => `<div class="it"><div class="cod">${esc(x.codigo)}</div><div class="d">${esc(desc(x))}</div>
        <div class="g2"><span>${num(x.teorico)} → ${num(x.final)} = <b>${x.diferencia > 0 ? '+' : ''}${num(x.diferencia)}</b></span><span class="n">${dinero(x.dif_costo)}</span></div></div>`;
      const ent = ctx.filas.filter((x) => x.diferencia > 0);
      const sal = ctx.filas.filter((x) => x.diferencia < 0);
      return `${encTicket(ctx, 'AJUSTE DE INVENTARIO')}
        ${ent.length ? `<div class="tc"><b>ENTRADAS</b></div>${ent.map(linea).join('')}<div class="g2"><b>Total entradas</b><b class="n">${dinero(sumar(ent, 'dif_costo'))}</b></div><div class="sep"></div>` : ''}
        ${sal.length ? `<div class="tc"><b>SALIDAS</b></div>${sal.map(linea).join('')}<div class="g2"><b>Total salidas</b><b class="n">${dinero(sumar(sal, 'dif_costo'))}</b></div>` : ''}
        <div class="sep2"></div><div class="g2"><b>AJUSTE NETO</b><b class="n">${dinero(sumar(ctx.filas, 'dif_costo'))}</b></div>
        <div class="firma">Autorizó</div>`;
    },
  });

  registrar({
    id: 'sin-contar',
    titulo: 'Artículos sin contar',
    descripcion: 'Artículos del stock teórico que no tienen ningún conteo, con su existencia y valor en sistema.',
    formato: 'carta',
    filtrar: (f) => f.filter((x) => x.sin_contar && x.correccion == null && !x.no_catalogado),
    generar(ctx) {
      return `${encCarta(ctx, 'Artículos sin contar')}
        <table><thead><tr><th>Código</th><th>Descripción</th><th>Categoría</th><th class="n">Teórico</th><th class="n">Valor costo</th><th>Reconteo</th></tr></thead>
        <tbody>${ctx.filas.map((x) => `<tr><td>${esc(x.codigo)}</td><td>${esc(desc(x))}</td><td>${esc(x.categoria || '')}</td><td class="n">${num(x.teorico)}</td><td class="n">${dinero(x.valor_teorico)}</td><td style="width:22mm;border-bottom:1px solid #000"></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="3">${num(ctx.filas.length)} artículos</td><td class="n">${num(sumar(ctx.filas, 'teorico'))}</td><td class="n">${dinero(sumar(ctx.filas, 'valor_teorico'))}</td><td></td></tr></tfoot></table>`;
    },
  });

  registrar({
    id: 'resumen',
    titulo: 'Resumen ejecutivo',
    descripcion: 'Indicadores generales del inventario y diferencias agrupadas por categoría.',
    formato: 'carta',
    generar(ctx) {
      const s = ctx.resumen;
      const cats = {};
      for (const x of ctx.filas) {
        const k = x.categoria || '(sin categoría)';
        const c = cats[k] || (cats[k] = { n: 0, dif: 0, teo: 0, fin: 0, falt: 0, sobr: 0 });
        c.n++; c.teo += x.valor_teorico; c.fin += x.valor_final; c.dif += x.dif_costo;
        if (x.dif_costo < 0) c.falt += x.dif_costo; else c.sobr += x.dif_costo;
      }
      const exact = s.contados ? (100 * (s.contados - ctx.filas.filter((x) => !x.sin_contar && x.diferencia !== 0).length) / s.contados) : 0;
      return `${encCarta(ctx, 'Resumen de inventario')}
        <div class="resumen">
          <div><span>Artículos</span><b>${num(s.articulos)}</b></div>
          <div><span>Contados / sin contar</span><b>${num(s.contados)}</b> / ${num(s.sin_contar)}</div>
          <div><span>Con diferencia</span><b>${num(s.con_diferencia)}</b></div>
          <div><span>Exactitud (contados)</span><b>${exact.toFixed(1)}%</b></div>
          <div><span>Valor teórico (costo)</span><b>${dinero(s.valor_teorico)}</b></div>
          <div><span>Valor físico (costo)</span><b>${dinero(s.valor_final)}</b></div>
          <div><span>Faltante / sobrante</span><b>${dinero(s.costo_faltante)}</b> / ${dinero(s.costo_sobrante)}</div>
          <div><span>Diferencia neta (costo / venta)</span><b>${dinero(s.costo_neto)}</b> / ${dinero(s.venta_neta)}</div>
        </div>
        <div class="seccion">Por categoría</div>
        <table><thead><tr><th>Categoría</th><th class="n">Artículos</th><th class="n">Valor teórico</th><th class="n">Valor físico</th><th class="n">Faltante</th><th class="n">Sobrante</th><th class="n">Neto</th></tr></thead>
        <tbody>${Object.entries(cats).sort((a, b) => a[1].dif - b[1].dif).map(([k, c]) => `<tr><td>${esc(k)}</td><td class="n">${num(c.n)}</td><td class="n">${dinero(c.teo)}</td><td class="n">${dinero(c.fin)}</td><td class="n">${dinero(c.falt)}</td><td class="n">${dinero(c.sobr)}</td><td class="n neg">${dinero(c.dif)}</td></tr>`).join('')}</tbody></table>
        <div class="firmas"><div>Elaboró</div><div>Auditor</div><div>Gerencia</div></div>`;
    },
  });

  function registrar(def) { lista.push(def); }

  window.Reportes = { lista, registrar, imprimir, CSS };
})();
