# Sistema de captura, revisión y validación de inventarios

Aplicación web para red local: los **celulares** cuentan (escaneo con cámara o captura manual) y la **PC** carga el stock teórico, revisa, corrige e imprime.

## Requisitos e instalación

- Node.js **22.13 o superior** (usa la base de datos SQLite integrada en Node, sin instalar nada más).
- PC y celulares en la misma red Wi‑Fi.

```bash
npm install
```

```bash
npm start
```

En la consola aparecen las direcciones:

```
PC (revisión):     http://localhost:3000/pc
Celulares:         https://192.168.1.50:3443/m
```

- **Usuario inicial:** `admin` / `admin` (el sistema pide cambiar la contraseña).
- **Celulares:** abra la dirección `https://…:3443/m`. La primera vez el navegador avisa que el certificado no es de confianza → "Avanzado" → "Continuar". Hace falta HTTPS para que el navegador permita usar la cámara.
- Los datos se guardan en `data/inventario.db` (respalde esa carpeta). Puertos configurables con las variables de entorno `PORT`, `HTTPS_PORT` y `DATA_DIR`.

## Roles

| Rol | Puede |
|---|---|
| Contador | Entrar desde el celular, capturar conteos y editar **sus propios** conteos |
| Auditor | Todo lo anterior + panel de PC: cargar stock, editar/eliminar/agregar cualquier conteo, correcciones, reportes |
| Administrador | Todo lo anterior + usuarios, nombre de la empresa, eliminar inventarios |

## Flujo de trabajo

1. **Inventarios y stock** (PC): cree un inventario, márquelo como *activo* y cargue el archivo (.xlsx/.xls/.csv) con `CODIGO, DESCRIPCION, PRECIO VTA, COSTO, CANTIDAD`. Columnas opcionales: `CATEGORIA`, `UBICACION`, `CODIGO BARRAS` (códigos alternos, separados por coma, para cuando el código de barras no es igual al SKU). Hay una plantilla para descargar.
2. **Conteo** (celular): cada contador entra con su usuario y pone un nombre al dispositivo. Al escanear o teclear el código se muestra la descripción y el teclado numérico. Opciones: *modo rápido* (cada lectura = 1 pieza), búsqueda por descripción, lectores de código de barras Bluetooth o integrados (funcionan como teclado en el campo de código). Si se pierde el Wi‑Fi, los conteos se guardan en el celular y se envían solos cuando vuelve la conexión.
3. **Conteos** (PC): concentrado en tiempo real con contador, dispositivo y fecha/hora; el auditor puede editar, eliminar (queda registrado y se puede ver) y agregar conteos.
4. **Revisión** (PC): suma todos los conteos por artículo y los compara con el stock teórico. Muestra la diferencia en piezas, a costo y a precio de venta. Tiene filtros generales y por columna (`>0`, `<0`, `!=0`, `10..20`), orden por cualquier columna (Shift+clic para ordenar por varias) y la columna **Corrección**, donde se escribe la cantidad correcta y se pasa a la siguiente fila con Enter. Clic en un código para ver todos sus conteos.
5. **Reportes**: diferencias (ticket 80 mm), hoja de reconteo a ciegas (80 mm), ajuste de inventario (carta y 80 mm), artículos sin contar y resumen ejecutivo por categoría. Exportaciones a Excel: revisión, archivo de ajuste e historial de conteos.
6. Cierre el inventario cuando termine; ya no acepta cambios (se puede reabrir).

**Cantidad final** = Corrección si existe; si no, la suma de los conteos. **Diferencia** = Final − Teórico.

Toda alta, edición, eliminación, corrección o carga queda registrada en la **Bitácora**.

## Estructura (para futuras ampliaciones)

```
server.js                 arranque HTTP/HTTPS y registro de módulos de API
src/db.js                 SQLite + migraciones versionadas (agregue nuevas al final de MIGRACIONES)
src/auth.js               sesiones por token y roles
src/routes/*.js           un archivo por módulo (sistema, inventarios, conteos, revision)
public/m/                 app del celular
public/pc/pc.js           panel de PC
public/pc/reportes.js     registro de reportes: Reportes.registrar({ id, titulo, formato, filtrar, generar })
```

Ya está previsto en el modelo de datos: `categoria`, `ubicacion` y `extra` (columnas no reconocidas del archivo, en JSON) en productos; `ubicacion` en conteos; múltiples inventarios con historial. Así se pueden agregar conteos por ubicación, análisis por categoría, segundo conteo/reconteo dirigido, etc., sin rehacer lo existente.
