// Punto de entrada para empaquetar el SDK de Firebase (sólo lo que usa la app)
export { initializeApp, deleteApp } from 'firebase/app';
export {
  initializeAuth, indexedDBLocalPersistence, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  onAuthStateChanged, updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  browserLocalPersistence, inMemoryPersistence,
} from 'firebase/auth';
export {
  initializeFirestore, getFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, getDocsFromCache, setDoc, updateDoc, deleteDoc, addDoc, writeBatch, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, Timestamp, getCountFromServer, runTransaction,
} from 'firebase/firestore';
