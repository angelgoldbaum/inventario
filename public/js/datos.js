// Capa de datos sobre Firebase (Auth + Firestore). Toda la app accede a los datos por aquí.
//
// Modelo en Firestore:
//   config/sistema                      { empresa, inventario_activo, creado }
//   usuarios/{uid}                      { usuario, nombre, rol: contador|auditor|admin, activo }
//   dispositivos/{dispositivo_id}       { usuario_id, usuario_nombre, dispositivo_nombre, tipo, ultimo }
//   inventarios/{id}                    { nombre, estado, notas, productos, catalogo_partes, catalogo_version, stock_archivo, stock_cargado, creado, cerrado }
//     catalogo/{n}                      { items: [ {c, d, pv, co, q, cat, ub, alt, x} ] }   (stock teórico en partes)
//     conteos/{uuid}                    { codigo, codigo_leido, cantidad, usuario_id, usuario_nombre, dispositivo_id, dispositivo_nombre, origen, creado, eliminado, ... }
//     correcciones/{codigo}             { codigo, cantidad, nota, usuario_id, usuario_nombre, modificado }
//     bitacora/{auto}                   { ts, usuario_id, usuario_nombre, accion, ref, detalle }
import * as F from '/vendor/firebase.js';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const DOMINIO_CORREO = 'inventario.app'; // los usuarios entran con "usuario"; Firebase Auth usa usuario@inventario.app
const TAM_PARTE = 1000;

let app, auth, db, configFirebase;
export let perfil = null; // usuario autenticado: { uid, usuario, nombre, rol, activo }

export async function iniciar() {
  if (app) return;
  try {
    const r = await fetch('/__/firebase/init.json');
    if (!r.ok) throw new Error();
    configFirebase = await r.json();
  } catch {
    if (!LOCAL) throw new Error('No se pudo cargar la configuración de Firebase');
    configFirebase = { projectId: 'demo-inventario', apiKey: 'demo-key', authDomain: 'demo-inventario.firebaseapp.com' };
  }
  app = F.initializeApp(configFirebase);
  // sin resolvedor de ventanas emergentes: no se carga el script externo de Google
  auth = F.initializeAuth(app, { persistence: [F.indexedDBLocalPersistence, F.browserLocalPersistence] });
  let cache;
  try { cache = F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }); } catch { cache = undefined; }
  db = F.initializeFirestore(app, cache ? { localCache: cache } : {});
  if (LOCAL && configFirebase.projectId.startsWith('demo-')) {
    F.connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
    F.connectFirestoreEmulator(db, location.hostname, 8080);
  }
}

// ---------------- utilidades ----------------
const d = (...p) => F.doc(db, ...p);
const c = (...p) => F.collection(db, ...p);
export const idCodigo = (codigo) => encodeURIComponent(String(codigo)).replace(/\./g, '%2E') || '%20';
export const ahora = () => F.serverTimestamp();
export const aFecha = (ts) => (ts?.toDate ? ts.toDate().toISOString() : ts || null);
const correoDe = (usuario) => `${String(usuario).trim().toLowerCase()}@${DOMINIO_CORREO}`;
export const usuarioValido = (u) => /^[a-z0-9._-]{2,40}$/i.test(String(u).trim());

function mensajeError(e) {
  const m = {
    'auth/invalid-credential': 'Usuario o contraseña incorrectos',
    'auth/wrong-password': 'Usuario o contraseña incorrectos',
    'auth/user-not-found': 'Usuario o contraseña incorrectos',
    'auth/invalid-email': 'Usuario inválido',
    'auth/too-many-requests': 'Demasiados intentos. Espere unos minutos.',
    'auth/email-already-in-use': 'Ese usuario ya existe',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres',
    'auth/network-request-failed': 'Sin conexión a internet',
    'auth/requires-recent-login': 'Vuelva a iniciar sesión para cambiar la contraseña',
    'permission-denied': 'No tiene permiso para esta operación (o el inventario está cerrado)',
    unavailable: 'Sin conexión con el servidor',
  };
  return new Error(m[e?.code] || e?.message || String(e));
}
const envolver = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { throw mensajeError(e); } };

// ---------------- sistema / sesión ----------------
export const leerSistema = envolver(async () => {
  const s = await F.getDoc(d('config', 'sistema'));
  return s.exists() ? s.data() : null;
});

export function escucharSistema(cb) {
  return F.onSnapshot(d('config', 'sistema'), (s) => cb(s.exists() ? s.data() : null), () => {});
}

// Primera configuración: crea el administrador, la configuración y el primer inventario
export const configurarSistema = envolver(async ({ empresa, usuario, nombre, password }) => {
  if (!usuarioValido(usuario)) throw new Error('Usuario inválido (use letras, números, punto o guion)');
  const cred = await F.createUserWithEmailAndPassword(auth, correoDe(usuario), password);
  const uid = cred.user.uid;
  const b = F.writeBatch(db);
  b.set(d('usuarios', uid), { usuario: usuario.trim().toLowerCase(), nombre, rol: 'admin', activo: true, creado: ahora() });
  b.set(d('config', 'sistema'), { empresa: empresa || 'Mi Empresa', inventario_activo: null, creado: ahora() });
  await b.commit();
  const inv = await F.addDoc(c('inventarios'), nuevoInventario('Inventario inicial'));
  await F.updateDoc(d('config', 'sistema'), { inventario_activo: inv.id });
});

export const entrar = envolver(async (usuario, password) => {
  const cred = await F.signInWithEmailAndPassword(auth, correoDe(usuario), password);
  return cargarPerfil(cred.user);
});

async function cargarPerfil(user) {
  const s = await F.getDoc(d('usuarios', user.uid));
  if (!s.exists() || !s.data().activo) {
    await F.signOut(auth);
    throw new Error('Usuario desactivado o no registrado en el sistema');
  }
  perfil = { uid: user.uid, ...s.data() };
  return perfil;
}

// cb(perfil|null) cada vez que cambia la sesión
export function alCambiarSesion(cb) {
  return F.onAuthStateChanged(auth, async (user) => {
    if (!user) { perfil = null; return cb(null); }
    try { cb(await cargarPerfil(user)); } catch (e) {
      // sin conexión: usa el perfil guardado en caché si existe
      if (perfil?.uid === user.uid) cb(perfil); else cb(null, e);
    }
  });
}

export const salir = envolver(() => F.signOut(auth));

export const cambiarMiPassword = envolver(async (actual, nueva) => {
  const u = auth.currentUser;
  await F.reauthenticateWithCredential(u, F.EmailAuthProvider.credential(u.email, actual));
  await F.updatePassword(u, nueva);
});

export const actualizarConfig = envolver((datos) => F.updateDoc(d('config', 'sistema'), datos));

// ---------------- usuarios ----------------
export const listarUsuarios = envolver(async () => {
  const s = await F.getDocs(c('usuarios'));
  return s.docs.map((x) => ({ uid: x.id, ...x.data() })).sort((a, b) => a.nombre.localeCompare(b.nombre));
});

// Se usa una segunda instancia de Firebase para crear la cuenta sin cerrar la sesión del administrador
export const crearUsuario = envolver(async ({ usuario, nombre, rol, password }) => {
  if (!usuarioValido(usuario)) throw new Error('Usuario inválido (use letras, números, punto o guion)');
  const sec = F.initializeApp(configFirebase, `alta-${Date.now()}`);
  try {
    const a2 = F.initializeAuth(sec, { persistence: F.inMemoryPersistence });
    if (LOCAL && configFirebase.projectId.startsWith('demo-')) F.connectAuthEmulator(a2, `http://${location.hostname}:9099`, { disableWarnings: true });
    const cred = await F.createUserWithEmailAndPassword(a2, correoDe(usuario), password);
    await F.setDoc(d('usuarios', cred.user.uid), { usuario: usuario.trim().toLowerCase(), nombre, rol, activo: true, creado: ahora() });
    await F.signOut(a2);
    await bitacora(null, 'usuario_crear', usuario, { rol });
  } finally { await F.deleteApp(sec); }
});

export const actualizarUsuario = envolver(async (uid, datos) => {
  await F.updateDoc(d('usuarios', uid), datos);
  await bitacora(null, 'usuario_editar', uid, datos);
});

// ---------------- dispositivos ----------------
export async function latido(tipo, dispositivo_nombre) {
  if (!perfil) return;
  try {
    await F.setDoc(d('dispositivos', U.dispositivoId()), {
      usuario_id: perfil.uid, usuario_nombre: perfil.nombre, dispositivo_nombre: dispositivo_nombre || '', tipo,
      agente: navigator.userAgent.slice(0, 160), ultimo: ahora(),
    }, { merge: true });
  } catch { /* sin conexión */ }
}
export const listarDispositivos = envolver(async () => {
  const s = await F.getDocs(c('dispositivos'));
  return s.docs.map((x) => ({ id: x.id, ...x.data(), ultimo: aFecha(x.data().ultimo) }))
    .sort((a, b) => String(b.ultimo).localeCompare(String(a.ultimo)));
});
export const quitarDispositivo = envolver((id) => F.deleteDoc(d('dispositivos', id)));

// ---------------- inventarios ----------------
function nuevoInventario(nombre, notas = '') {
  return { nombre, notas, estado: 'abierto', productos: 0, catalogo_partes: 0, catalogo_version: 0, stock_archivo: null, stock_cargado: null, creado: ahora(), cerrado: null };
}
export function escucharInventarios(cb) {
  return F.onSnapshot(c('inventarios'), (s) => cb(s.docs.map((x) => ({ id: x.id, ...x.data(), creado: aFecha(x.data().creado), stock_cargado: aFecha(x.data().stock_cargado) }))
    .sort((a, b) => String(b.creado).localeCompare(String(a.creado)))), (e) => console.error(e));
}
export function escucharInventario(id, cb) {
  return F.onSnapshot(d('inventarios', id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), () => {});
}
export const crearInventario = envolver(async (nombre, notas, activar) => {
  const r = await F.addDoc(c('inventarios'), nuevoInventario(nombre, notas));
  if (activar) await F.updateDoc(d('config', 'sistema'), { inventario_activo: r.id });
  await bitacora(r.id, 'inventario_crear', nombre, null);
  return r.id;
});
export const actualizarInventario = envolver(async (id, datos) => {
  if (datos.estado) datos.cerrado = datos.estado === 'cerrado' ? ahora() : null;
  await F.updateDoc(d('inventarios', id), datos);
  await bitacora(id, 'inventario_editar', null, { ...datos, cerrado: undefined });
});
export const activarInventario = envolver(async (id) => {
  await F.updateDoc(d('config', 'sistema'), { inventario_activo: id });
  await bitacora(id, 'inventario_activar', null, null);
});
async function borrarColeccion(ref) {
  for (;;) {
    const s = await F.getDocs(F.query(ref, F.limit(400)));
    if (s.empty) return;
    const b = F.writeBatch(db);
    s.docs.forEach((x) => b.delete(x.ref));
    await b.commit();
  }
}
export const eliminarInventario = envolver(async (id) => {
  for (const sub of ['catalogo', 'conteos', 'correcciones', 'bitacora']) await borrarColeccion(c('inventarios', id, sub));
  await F.deleteDoc(d('inventarios', id));
});

// ---------------- catálogo (stock teórico) ----------------
const aItem = (p) => ({ c: p.codigo, d: p.descripcion, pv: p.precio_vta, co: p.costo, q: p.cantidad, cat: p.categoria || null, ub: p.ubicacion || null, alt: p.alternos?.length ? p.alternos : null, x: p.extra || null });
const deItem = (i) => ({ codigo: i.c, descripcion: i.d, precio_vta: i.pv || 0, costo: i.co || 0, cantidad: i.q || 0, categoria: i.cat || null, ubicacion: i.ub || null, alternos: i.alt || [], extra: i.x || null });

export const cargarCatalogo = envolver(async (invId, { soloCache = false } = {}) => {
  const ref = c('inventarios', invId, 'catalogo');
  let s;
  if (soloCache) s = await F.getDocsFromCache(ref);
  else {
    try { s = await F.getDocs(ref); } catch (e) { s = await F.getDocsFromCache(ref).catch(() => { throw e; }); }
  }
  return s.docs.sort((a, b) => Number(a.id) - Number(b.id)).flatMap((x) => x.data().items.map(deItem));
});

export const guardarCatalogo = envolver(async (invId, productos, archivo, modo) => {
  const ref = c('inventarios', invId, 'catalogo');
  let lista = productos;
  if (modo === 'actualizar') {
    const prev = new Map((await cargarCatalogo(invId)).map((p) => [p.codigo, p]));
    for (const p of productos) prev.set(p.codigo, p);
    lista = [...prev.values()];
  }
  await borrarColeccion(ref);
  const partes = [];
  for (let i = 0; i < lista.length; i += TAM_PARTE) partes.push(lista.slice(i, i + TAM_PARTE));
  for (let i = 0; i < partes.length; i += 5) {
    const b = F.writeBatch(db);
    partes.slice(i, i + 5).forEach((p, j) => b.set(F.doc(ref, String(i + j)), { items: p.map(aItem) }));
    await b.commit();
  }
  await F.updateDoc(d('inventarios', invId), {
    productos: lista.length, catalogo_partes: partes.length, catalogo_version: Date.now(), stock_archivo: archivo, stock_cargado: ahora(),
  });
  await bitacora(invId, 'stock_cargar', archivo, { modo, articulos: lista.length });
  return lista.length;
});

// Índice en memoria para búsquedas rápidas (sirve también sin conexión)
export function indexarCatalogo(productos) {
  const porCodigo = new Map();
  const porAlterno = new Map();
  for (const p of productos) {
    porCodigo.set(p.codigo, p);
    for (const a of p.alternos || []) porAlterno.set(a, p);
  }
  return {
    productos,
    buscar(leido) {
      const k = String(leido ?? '').trim();
      return porCodigo.get(k) || porAlterno.get(k) || (/^0+\d+$/.test(k) ? porCodigo.get(k.replace(/^0+/, '')) : null) || null;
    },
    sugerir(q, max = 25) {
      const palabras = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!palabras.length) return [];
      const r = [];
      for (const p of productos) {
        const t = `${p.codigo} ${p.descripcion}`.toLowerCase();
        if (palabras.every((w) => t.includes(w))) { r.push(p); if (r.length >= max) break; }
      }
      return r;
    },
  };
}

// ---------------- conteos ----------------
const deConteo = (x) => {
  const v = x.data({ serverTimestamps: 'estimate' });
  return { id: x.id, ...v, creado: aFecha(v.creado), modificado: aFecha(v.modificado), pendiente: x.metadata.hasPendingWrites };
};

// No se espera la confirmación del servidor: si no hay conexión, Firestore lo guarda y lo envía después.
export function registrarConteo(invId, { codigo, codigo_leido, cantidad, origen = 'movil', usuario_id, usuario_nombre, dispositivo_nombre }) {
  const id = U.uuid();
  const p = F.setDoc(d('inventarios', invId, 'conteos', id), {
    codigo, codigo_leido: codigo_leido ?? codigo, cantidad: Number(cantidad),
    usuario_id: usuario_id || perfil.uid, usuario_nombre: usuario_nombre || perfil.nombre,
    dispositivo_id: U.dispositivoId(), dispositivo_nombre: dispositivo_nombre || '', origen, ubicacion: null,
    creado: ahora(), creado_local: new Date().toISOString(), eliminado: false,
  }).catch((e) => { throw mensajeError(e); });
  return { id, confirmado: p };
}

export function escucharMisConteos(invId, cb, err) {
  const q = F.query(c('inventarios', invId, 'conteos'), F.where('usuario_id', '==', perfil.uid), F.where('eliminado', '==', false));
  return F.onSnapshot(q, { includeMetadataChanges: true }, (s) => cb(s.docs.map(deConteo).sort((a, b) => String(b.creado).localeCompare(String(a.creado)))), err);
}

export function escucharConteos(invId, cb, err) {
  return F.onSnapshot(c('inventarios', invId, 'conteos'), (s) => cb(s.docs.map(deConteo), s.docChanges().filter((x) => x.type === 'added').map((x) => x.doc.id)), err);
}

export function editarConteo(invId, conteo, cambios) {
  const datos = { ...cambios, modificado: ahora(), modificado_por: perfil.uid, modificado_por_nombre: perfil.nombre };
  if (datos.cantidad != null) datos.cantidad = Number(datos.cantidad);
  const p = F.updateDoc(d('inventarios', invId, 'conteos', conteo.id), datos).catch((e) => { throw mensajeError(e); });
  const antes = Object.fromEntries(Object.keys(cambios).map((k) => [k, conteo[k]]));
  bitacora(invId, cambios.eliminado ? 'conteo_eliminar' : 'conteo_editar', conteo.codigo, { conteo: conteo.id, antes, despues: cambios, de: conteo.usuario_nombre }).catch(() => {});
  return p;
}

// ---------------- correcciones ----------------
export function escucharCorrecciones(invId, cb, err) {
  return F.onSnapshot(c('inventarios', invId, 'correcciones'), (s) => cb(new Map(s.docs.map((x) => {
    const v = x.data({ serverTimestamps: 'estimate' });
    return [v.codigo, { ...v, modificado: aFecha(v.modificado) }];
  }))), err);
}
export const fijarCorreccion = envolver(async (invId, codigo, cantidad, antes) => {
  const ref = d('inventarios', invId, 'correcciones', idCodigo(codigo));
  if (cantidad == null) await F.deleteDoc(ref);
  else await F.setDoc(ref, { codigo, cantidad, nota: null, usuario_id: perfil.uid, usuario_nombre: perfil.nombre, modificado: ahora() });
  bitacora(invId, cantidad == null ? 'correccion_quitar' : 'correccion_fijar', codigo, { antes, cantidad }).catch(() => {});
});

// ---------------- bitácora ----------------
export function bitacora(invId, accion, ref, detalle) {
  if (!perfil || !invId) return Promise.resolve();
  return F.addDoc(c('inventarios', invId, 'bitacora'), {
    ts: ahora(), usuario_id: perfil.uid, usuario_nombre: perfil.nombre, accion, ref: ref ?? null,
    detalle: detalle == null ? null : JSON.stringify(detalle),
  });
}
export const leerBitacora = envolver(async (invId) => {
  const s = await F.getDocs(F.query(c('inventarios', invId, 'bitacora'), F.orderBy('ts', 'desc'), F.limit(1000)));
  return s.docs.map((x) => ({ id: x.id, ...x.data(), ts: aFecha(x.data().ts) }));
});
