/* =========================================================
   COLLEGAMENTO A FIREBASE
   Questo file è l'unico che "parla" con Firebase:
   - login / logout (Authentication)
   - lettura in tempo reale e scrittura dei dati (Firestore)

   Struttura nel database (ogni utente vede solo la sua cartella):
     utenti/{uid}/zaini/{id}    { nome }
     utenti/{uid}/tasche/{id}   { nome, zainoId }
     utenti/{uid}/oggetti/{id}  { nome, tascaId, ultimaTascaId }
     utenti/{uid}/foto/{id}     { dati }   ← immagine come testo (data URL)
     utenti/{uid}/stato/tascaAttiva { tascaId, scade }
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

// Configurazione del progetto (non è segreta: l'accesso ai dati è
// protetto dal login e dalle regole di sicurezza di Firestore)
const configurazione = {
  apiKey: "AIzaSyDRiB7RZ0QYMUr4e9BDgAHIqJCCCZLb48o",
  authDomain: "zaino-bf113.firebaseapp.com",
  projectId: "zaino-bf113",
  storageBucket: "zaino-bf113.firebasestorage.app",
  messagingSenderId: "229292030414",
  appId: "1:229292030414:web:9edb3bc252a5bbf8de539f"
};

const app = initializeApp(configurazione);
const auth = getAuth(app);

// Cache locale persistente: l'app funziona anche offline e
// invia le modifiche quando torna la connessione
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const COLLEZIONI = ["zaini", "tasche", "oggetti", "foto", "stato"];

/* ---------- Login ---------- */
export const osservaUtente = callback => onAuthStateChanged(auth, callback);
export const accedi = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const esci = () => signOut(auth);

/* ---------- Lettura in tempo reale ----------
   Chiama aggiorna(collezione, elementi) ogni volta che qualcosa cambia
   (anche da un altro dispositivo o da un'altra scheda).
   Chiama pronto() una volta sola, quando tutte le collezioni sono arrivate.
   Restituisce una funzione per smettere di ascoltare. */
export function ascolta(uid, aggiorna, pronto, errore) {
  const arrivate = new Set();
  const stop = COLLEZIONI.map(nome =>
    onSnapshot(collection(db, "utenti", uid, nome), istantanea => {
      aggiorna(nome, istantanea.docs.map(d => ({ id: d.id, ...d.data() })));
      if (!arrivate.has(nome)) {
        arrivate.add(nome);
        if (arrivate.size === COLLEZIONI.length) pronto();
      }
    }, errore)
  );
  return () => stop.forEach(s => s());
}

/* ---------- Scrittura ---------- */
const senzaId = ({ id, ...resto }) => resto;
const rif = (uid, collezione, id) => doc(db, "utenti", uid, collezione, id);

// Salva un elemento (l'id diventa il nome del documento)
export const scrivi = (uid, collezione, elemento) =>
  setDoc(rif(uid, collezione, elemento.id), senzaId(elemento));

export const cancella = (uid, collezione, id) => deleteDoc(rif(uid, collezione, id));

// Tante operazioni insieme: ["set", collezione, elemento] o ["delete", collezione, id]
// Divise in gruppi per rispettare i limiti di Firestore (500 operazioni, ~10 MB)
export async function inBlocco(uid, operazioni) {
  let gruppo = writeBatch(db), conteggio = 0, peso = 0;
  const invii = [];
  for (const [tipo, collezione, x] of operazioni) {
    const dimensione = tipo === "set" ? JSON.stringify(x).length : 100;
    if (conteggio >= 400 || peso + dimensione > 8_000_000) {
      invii.push(gruppo.commit());
      gruppo = writeBatch(db); conteggio = 0; peso = 0;
    }
    if (tipo === "set") gruppo.set(rif(uid, collezione, x.id), senzaId(x));
    else gruppo.delete(rif(uid, collezione, x));
    conteggio++; peso += dimensione;
  }
  if (conteggio) invii.push(gruppo.commit());
  await Promise.all(invii);
}
