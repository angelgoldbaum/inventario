# Sistema de captura, revisión y validación de inventarios (Firebase)

Aplicación web alojada en **Firebase Hosting**, con datos en **Firestore** y usuarios en **Firebase Authentication**. No necesita servidor propio.

- **Celulares** (`https://<proyecto>.web.app/m`): cuentan escaneando con la cámara o tecleando el SKU.
- **PC** (`https://<proyecto>.web.app/pc`): carga del stock teórico, concentrado en vivo, revisión, correcciones, reportes y usuarios.

## Primer uso

1. Abra `/pc`. La primera vez aparece **Configuración inicial**: escriba el nombre de la empresa y cree la cuenta de administrador.
2. En **Usuarios y dispositivos**, cree a los contadores (usuario + contraseña de al menos 6 caracteres).
3. En **Inventarios y stock**, cargue el archivo (.xlsx/.xls/.csv) con `CODIGO, DESCRIPCION, PRECIO VTA, COSTO, CANTIDAD`. Opcionales: `CATEGORIA`, `UBICACION`, `CODIGO BARRAS` (códigos alternos separados por coma).
4. Los contadores abren `/m` en el celular, entran con su usuario y le ponen nombre al dispositivo.

## Roles

| Rol | Puede |
|---|---|
| Contador | Capturar desde el celular y editar **sus propios** conteos |
| Auditor | Panel de PC: stock, editar/eliminar/agregar cualquier conteo, correcciones, reportes |
| Administrador | Todo lo anterior + usuarios, nombre de la empresa, eliminar inventarios |

Los permisos se hacen cumplir en el servidor con las reglas de `firestore.rules`, no solo en la pantalla.

## Funcionamiento

- **Celular:** el catálogo se descarga una vez al entrar, así que la búsqueda es instantánea y funciona sin conexión. Si se cae el internet, los conteos se guardan en el celular y Firestore los envía al reconectar. Se muestra "N sin enviar" mientras haya pendientes. Hay *modo rápido* (cada lectura = 1 pieza) y búsqueda por descripción. Los lectores de código Bluetooth funcionan como teclado en el campo de código.
- **Conteos y Revisión** se actualizan **en vivo**, sin recargar.
- **Cantidad final** = Corrección si existe; si no, la suma de los conteos. **Diferencia** = Final − Teórico.
- **Reportes:** diferencias (ticket 80 mm), hoja de reconteo a ciegas (80 mm), ajuste de inventario (carta y 80 mm), sin contar y resumen por categoría. Exportación a Excel: revisión, archivo de ajuste e historial de conteos.
- **Bitácora:** ediciones, eliminaciones, correcciones, cargas de stock y cambios de inventario.

**Limitación:** desde la app no se puede cambiar la contraseña de *otro* usuario. Si alguien la olvida, desactívelo y créele un usuario nuevo, o restablézcala en la consola de Firebase (Authentication). Cada quien puede cambiar la suya con el botón "Contraseña".

## Desarrollo local (emuladores)

Requiere Node 20+ y Java 11+.

```bash
npm install
```

```bash
npm run emuladores
```

Abra `http://localhost:5000/pc`. Los datos de los emuladores se borran al detenerlos.

## Publicar en Firebase

Necesita una llave de cuenta de servicio con rol *Firebase Admin* (Consola de Firebase → Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada).

```bash
GOOGLE_APPLICATION_CREDENTIALS=/ruta/llave.json ./scripts/desplegar.sh <ID-del-proyecto>
```

El script crea la app web y la base de datos si no existen, activa el inicio de sesión con correo/contraseña y publica el sitio y las reglas. Para actualizaciones posteriores basta con `npm run deploy` (estando autenticado con `firebase login`).

## Estructura

```
firebase.json, firestore.rules      configuración de Hosting y reglas de seguridad
build/firebase-entry.js             partes del SDK de Firebase que se empaquetan en public/vendor/firebase.js
public/js/datos.js                  capa de datos: modelo de Firestore y todas las operaciones
public/js/revision.js               totalización y comparación contra el teórico
public/js/stock.js                  lectura del archivo de stock y exportación a Excel
public/m/                           app del celular
public/pc/pc.js                     panel de PC
public/pc/reportes.js               registro de reportes: Reportes.registrar({ id, titulo, formato, filtrar, generar })
```

Para crecer: los productos ya guardan `categoria`, `ubicacion` y `extra` (columnas no reconocidas del archivo); los conteos tienen campo `ubicacion`; hay múltiples inventarios con historial. Un reporte nuevo se agrega con una llamada a `Reportes.registrar`.
