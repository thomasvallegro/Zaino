/* =========================================================
   SERVICE WORKER
   Un piccolo programma che il browser tiene in background:
   salva una copia dei file dell'app, così la web app si apre
   anche senza connessione.
   - File dell'app: prima la rete (per ricevere gli aggiornamenti),
     se non c'è rete la copia salvata.
   - Librerie Firebase (versione fissa): prima la copia salvata.
   ========================================================= */

const CACHE = "zaino-v6";
const FILE = ["./", "./index.html", "./style.css", "./app.js", "./db.js", "./icona.png", "./icona-512.png", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILE)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(nomi => Promise.all(nomi.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(risposta => {
          if (risposta.ok && !url.search) {
            const copia = risposta.clone();
            caches.open(CACHE).then(c => c.put(e.request, copia));
          }
          return risposta;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  } else if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    e.respondWith(
      caches.match(e.request).then(salvata => salvata || fetch(e.request).then(risposta => {
        if (risposta.ok) {
          const copia = risposta.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return risposta;
      }))
    );
  }
});
