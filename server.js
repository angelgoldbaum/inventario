// Servidor de Inventarios: sirve la app móvil (/m), el panel de PC (/pc) y la API (/api)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const { inicializar, DATA_DIR } = require('./src/db');

inicializar();

const { autenticar } = require('./src/auth');
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '2mb' }));

// Info pública (puerto HTTPS para redirigir celulares)
app.get('/info.json', (req, res) => res.json({ https_port: HTTPS_PORT }));

// API
const api = express.Router();
api.use(require('./src/routes/sistema')); // incluye /auth/login (público) y luego exige sesión
api.use(autenticar);
api.use(require('./src/routes/inventarios'));
api.use(require('./src/routes/conteos'));
api.use(require('./src/routes/revision'));
// Futuros módulos (ubicaciones, análisis, etc.): api.use(require('./src/routes/nuevo-modulo'));
api.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use('/api', api);

// Archivos estáticos
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { extensions: ['html'] }));
app.get('/m', (req, res) => res.sendFile(path.join(pub, 'm', 'index.html')));
app.get('/pc', (req, res) => res.sendFile(path.join(pub, 'pc', 'index.html')));

// Manejo de errores -> JSON
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

// ---- Arranque HTTP + HTTPS (la cámara del celular requiere HTTPS) ----
function ipsLocales() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function certificado() {
  const keyF = path.join(DATA_DIR, 'key.pem');
  const certF = path.join(DATA_DIR, 'cert.pem');
  const ips = ipsLocales();
  const metaF = path.join(DATA_DIR, 'cert-ips.json');
  const previo = fs.existsSync(metaF) ? JSON.parse(fs.readFileSync(metaF, 'utf8')) : [];
  if (fs.existsSync(keyF) && fs.existsSync(certF) && ips.every((ip) => previo.includes(ip))) {
    return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) };
  }
  const selfsigned = require('selfsigned');
  const todas = [...new Set([...previo, ...ips, '127.0.0.1'])];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'inventario.local' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...todas.map((ip) => ({ type: 7, ip }))] }],
  });
  fs.writeFileSync(keyF, pems.private);
  fs.writeFileSync(certF, pems.cert);
  fs.writeFileSync(metaF, JSON.stringify(todas));
  return { key: pems.private, cert: pems.cert };
}

http.createServer(app).listen(PORT, () => {
  https.createServer(certificado(), app).listen(HTTPS_PORT, () => {
    const ips = ipsLocales();
    console.log('\n=== Sistema de Inventarios en marcha ===');
    console.log(`PC (revisión):     http://localhost:${PORT}/pc`);
    for (const ip of ips) console.log(`PC en red:         http://${ip}:${PORT}/pc`);
    for (const ip of ips) console.log(`Celulares:         https://${ip}:${HTTPS_PORT}/m`);
    console.log('(En el celular acepte la advertencia del certificado la primera vez)\n');
  });
});
