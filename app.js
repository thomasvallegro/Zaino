"use strict";

/* =========================================================
   1. DATI
   L'inventario è un unico oggetto JavaScript, salvato in
   localStorage (l'archivio di Safari) come testo JSON.
   Le foto sono più pesanti: vanno in IndexedDB (sezione 2).
   ========================================================= */

const CHIAVE = "zaino-dati-v1";
const DURATA_TASCA_ATTIVA = 2 * 60 * 1000; // 2 minuti, in millisecondi

function datiVuoti() {
  return {
    zaini: [],   // { id, nome }
    tasche: [],  // { id, nome, zainoId }
    oggetti: [], // { id, nome, tascaId, ultimaTascaId }  tascaId = null → "fuori"
    tascaAttiva: null, // { id, scade } dopo aver letto il tag di una tasca
    impostazioni: { rimuoviSfondo: true }
  };
}

function carica() {
  try {
    const testo = localStorage.getItem(CHIAVE);
    if (testo) {
      const d = Object.assign(datiVuoti(), JSON.parse(testo));
      d.impostazioni = Object.assign(datiVuoti().impostazioni, d.impostazioni);
      return d;
    }
  } catch (e) { /* archivio non disponibile o dati rovinati: si parte vuoti */ }
  return datiVuoti();
}

function salva() {
  try {
    localStorage.setItem(CHIAVE, JSON.stringify(dati));
  } catch (e) {
    mostraToast("Errore: impossibile salvare i dati");
  }
}

let dati = carica();

// Un id breve e (praticamente) unico, es. "lq3k9x2a7f"
function nuovoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------- Ricerche ---------- */
const trovaZaino   = id => dati.zaini.find(z => z.id === id);
const trovaTasca   = id => dati.tasche.find(t => t.id === id);
const trovaOggetto = id => dati.oggetti.find(o => o.id === id);
const trova = (tipo, id) => ({ zaino: trovaZaino, tasca: trovaTasca, oggetto: trovaOggetto })[tipo](id);
const tascheDi  = zainoId => dati.tasche.filter(t => t.zainoId === zainoId);
const oggettiIn = tascaId => dati.oggetti.filter(o => o.tascaId === tascaId);
const perNome = (a, b) => a.nome.localeCompare(b.nome, "it");

function oggettiInZaino(zainoId) {
  const idTasche = tascheDi(zainoId).map(t => t.id);
  return dati.oggetti.filter(o => idTasche.includes(o.tascaId));
}

// Testo leggibile della posizione: "Zaino scuola › Tasca frontale" oppure "Fuori"
function nomeTasca(tasca) {
  const zaino = trovaZaino(tasca.zainoId);
  return (zaino ? zaino.nome + " › " : "") + tasca.nome;
}
function posizione(oggetto) {
  const tasca = oggetto.tascaId && trovaTasca(oggetto.tascaId);
  return tasca ? nomeTasca(tasca) : "Fuori";
}

/* ---------- Modifiche ---------- */
function creaZaino(nome) {
  const zaino = { id: nuovoId(), nome };
  dati.zaini.push(zaino);
  salva();
  return zaino;
}

function eliminaZaino(id) {
  tascheDi(id).forEach(t => eliminaTasca(t.id));
  dati.zaini = dati.zaini.filter(z => z.id !== id);
  salva();
  impostaFoto(id, null);
}

function creaTasca(zainoId, nome) {
  const tasca = { id: nuovoId(), nome, zainoId };
  dati.tasche.push(tasca);
  salva();
  return tasca;
}

// Eliminando una tasca, i suoi oggetti finiscono "fuori"
function eliminaTasca(id) {
  dati.oggetti.forEach(o => {
    if (o.tascaId === id) o.tascaId = null;
    if (o.ultimaTascaId === id) o.ultimaTascaId = null;
  });
  if (dati.tascaAttiva && dati.tascaAttiva.id === id) dati.tascaAttiva = null;
  dati.tasche = dati.tasche.filter(t => t.id !== id);
  salva();
}

function creaOggetto(nome, tascaId = null) {
  const oggetto = { id: nuovoId(), nome, tascaId, ultimaTascaId: tascaId };
  dati.oggetti.push(oggetto);
  salva();
  return oggetto;
}

// Sposta un oggetto in una tasca (o fuori, con tascaId = null)
function sposta(oggetto, tascaId) {
  oggetto.tascaId = tascaId;
  if (tascaId) oggetto.ultimaTascaId = tascaId; // ricorda dove stava
  salva();
}

function eliminaOggetto(id) {
  dati.oggetti = dati.oggetti.filter(o => o.id !== id);
  salva();
  impostaFoto(id, null);
}

/* =========================================================
   2. FOTO
   - Salvate in IndexedDB (un database del browser adatto ai file).
   - Prima di salvarle: rimpicciolite, sfondo rimosso, ritagliate.
   ========================================================= */

let dbPromessa;
function apriDb() {
  dbPromessa = dbPromessa || new Promise((ok, ko) => {
    const r = indexedDB.open("zaino-foto", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("foto");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
  return dbPromessa;
}

// Esegue un'operazione sul database e aspetta che sia completata
async function operazioneDb(modo, fn) {
  const db = await apriDb();
  return new Promise((ok, ko) => {
    const t = db.transaction("foto", modo);
    const risultato = fn(t.objectStore("foto"));
    t.oncomplete = () => ok(risultato && risultato.result);
    t.onerror = () => ko(t.error);
  });
}

async function leggiTutteLeFoto() {
  const tutte = {};
  await operazioneDb("readonly", store => {
    const cursore = store.openCursor();
    cursore.onsuccess = () => {
      const c = cursore.result;
      if (c) { tutte[c.key] = c.value; c.continue(); }
    };
  });
  return tutte;
}

// Indirizzi temporanei (blob:...) per mostrare le foto nelle <img>
const urlFoto = new Map();

function mettiInCache(id, blob) {
  if (urlFoto.has(id)) URL.revokeObjectURL(urlFoto.get(id));
  if (blob) urlFoto.set(id, URL.createObjectURL(blob));
  else urlFoto.delete(id);
}

// Salva (blob) o elimina (null) la foto di uno zaino / oggetto
async function impostaFoto(id, blob) {
  mettiInCache(id, blob);
  try {
    await operazioneDb("readwrite", s => (blob ? s.put(blob, id) : s.delete(id)));
  } catch (e) {
    mostraToast("Errore: foto non salvata");
  }
}

/* ---------- Elaborazione immagine ---------- */

function caricaImmagine(blob) {
  return new Promise((ok, ko) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("Immagine non leggibile")); };
    img.src = url;
  });
}

const canvasInBlob = (canvas, tipo, qualita) =>
  new Promise(ok => canvas.toBlob(ok, tipo, qualita));

// Rimpicciolisce l'immagine perché il lato più lungo sia al massimo "max" pixel
async function ridimensiona(blob, max, tipo) {
  const img = await caricaImmagine(blob);
  const scala = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scala);
  c.height = Math.round(img.naturalHeight * scala);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return canvasInBlob(c, tipo, 0.85);
}

// Dopo la rimozione dello sfondo: taglia i bordi trasparenti e rimpicciolisce
async function ritagliaTrasparenza(blob, max) {
  const img = await caricaImmagine(blob);
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const pixel = ctx.getImageData(0, 0, w, h).data;

  // Cerca il rettangolo che contiene tutti i pixel non trasparenti
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixel[(y * w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("Nessun soggetto trovato");

  const margine = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
  x0 = Math.max(0, x0 - margine); y0 = Math.max(0, y0 - margine);
  x1 = Math.min(w - 1, x1 + margine); y1 = Math.min(h - 1, y1 + margine);
  const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
  const scala = Math.min(1, max / Math.max(lw, lh));

  const out = document.createElement("canvas");
  out.width = Math.round(lw * scala);
  out.height = Math.round(lh * scala);
  out.getContext("2d").drawImage(c, x0, y0, lw, lh, 0, 0, out.width, out.height);
  return canvasInBlob(out, "image/png");
}

// Libreria di intelligenza artificiale che rimuove lo sfondo dentro il browser.
// Viene scaricata solo la prima volta che serve (~40 MB), poi resta in cache.
const URL_LIBRERIA = "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
let libreria;

async function rimuoviSfondo(blob, aggiornaStato) {
  libreria = libreria || import(URL_LIBRERIA);
  let modulo;
  try { modulo = await libreria; } catch (e) { libreria = null; throw e; }
  const rimuovi = modulo.removeBackground || modulo.default;
  return rimuovi(blob, {
    model: "isnet_quint8", // il modello più leggero, adatto all'iPhone
    output: { format: "image/png" },
    progress: (chiave, fatto, totale) => {
      if (String(chiave).startsWith("fetch") && totale) {
        aggiornaStato("Download del modello " + Math.round((fatto / totale) * 100) + "% (solo la prima volta)");
      }
    }
  });
}

// Da file scelto dall'utente → immagine pronta da salvare
async function preparaFoto(file, aggiornaStato) {
  const base = await ridimensiona(file, 1024, "image/jpeg");
  if (dati.impostazioni.rimuoviSfondo) {
    try {
      aggiornaStato("Rimozione dello sfondo…");
      const senzaSfondo = await rimuoviSfondo(base, aggiornaStato);
      aggiornaStato("Rifinitura…");
      return { blob: await ritagliaTrasparenza(senzaSfondo, 600), sfondoRimosso: true };
    } catch (e) {
      console.warn("Rimozione sfondo non riuscita:", e);
    }
  }
  return { blob: await ridimensiona(base, 600, "image/jpeg"), sfondoRimosso: false };
}

/* =========================================================
   3. TAG NFC
   Su ogni tag si scrive un indirizzo come
     https://.../zaino/?tag=o-ID   (oggetto)
     https://.../zaino/?tag=t-ID   (tasca)
   iPhone lo legge da solo e apre la pagina: qui la gestiamo.
   ========================================================= */

function indirizzoTag(tipo, id) {
  return location.origin + location.pathname + "?tag=" + tipo + "-" + id;
}

function tascaAttiva() {
  const ta = dati.tascaAttiva;
  if (ta && ta.scade > Date.now() && trovaTasca(ta.id)) return trovaTasca(ta.id);
  return null;
}

function gestisciTag() {
  const tag = new URLSearchParams(location.search).get("tag");
  if (!tag) return;
  // Togliamo "?tag=..." dall'indirizzo: ricaricando la pagina non si ripete l'azione
  history.replaceState(null, "", location.pathname + location.hash);

  const trattino = tag.indexOf("-");
  const tipo = tag.slice(0, trattino);
  const id = tag.slice(trattino + 1);

  if (tipo === "t") {
    const tasca = trovaTasca(id);
    if (!tasca) return mostraToast("Tag non riconosciuto");
    dati.tascaAttiva = { id, scade: Date.now() + DURATA_TASCA_ATTIVA };
    salva();
    location.hash = "#/tasca/" + id;
    return mostraToast("Tasca attiva: " + tasca.nome + ". Ora avvicina gli oggetti.");
  }

  if (tipo === "o") {
    const oggetto = trovaOggetto(id);
    if (!oggetto) return mostraToast("Tag non riconosciuto");
    const attiva = tascaAttiva();

    if (attiva) {
      // C'è una tasca selezionata → l'oggetto va lì
      dati.tascaAttiva.scade = Date.now() + DURATA_TASCA_ATTIVA; // rinnova i 2 minuti
      salva();
      location.hash = "#/tasca/" + attiva.id;
      if (oggetto.tascaId === attiva.id) return mostraToast(oggetto.nome + " è già qui");
      sposta(oggetto, attiva.id);
      return mostraToast(oggetto.nome + " → " + attiva.nome);
    }

    // Nessuna tasca selezionata → dentro/fuori
    location.hash = "#/oggetto/" + id;
    if (oggetto.tascaId) {
      const eraIn = posizione(oggetto);
      sposta(oggetto, null);
      return mostraToast(oggetto.nome + " tolto da " + eraIn);
    }
    const ultima = oggetto.ultimaTascaId && trovaTasca(oggetto.ultimaTascaId);
    if (ultima) {
      sposta(oggetto, ultima.id);
      return mostraToast(oggetto.nome + " → " + nomeTasca(ultima));
    }
    return mostraToast("Scegli dove mettere " + oggetto.nome);
  }

  mostraToast("Tag non riconosciuto");
}

/* =========================================================
   4. PEZZI DI INTERFACCIA
   ========================================================= */

// Icone disegnate in SVG (vettoriali: nitide a ogni dimensione)
const ICONE = {
  zaino: '<path d="M9 4.5V4a3 3 0 0 1 6 0v.5"/><rect x="4.5" y="4.5" width="15" height="16.5" rx="4.5"/><path d="M8.5 13h7v4h-7z"/><path d="M4.5 11h15"/>',
  scatola: '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  regola: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M20 18h0"/><circle cx="16" cy="6" r="2.5"/><circle cx="10" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/>',
  tasca: '<rect x="4" y="6" width="16" height="13" rx="3"/><path d="M4 10.5h16"/>',
  avanti: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  indietro: '<path d="m15 4.5-7.5 7.5 7.5 7.5"/>',
  piu: '<path d="M12 5v14M5 12h14"/>',
  foto: '<rect x="3" y="6.5" width="18" height="13.5" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8.5 6.5 10 4h4l1.5 2.5"/>',
  nfc: '<path d="M7 8.5a6 6 0 0 1 0 7M10.5 6.5a9 9 0 0 1 0 11M14 4.5a12 12 0 0 1 0 15"/>',
  spunta: '<path d="m5.5 12.5 4 4 9-9"/>',
  lente: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>'
};
function ico(nome, dim = 24, spessore = 1.8) {
  return `<svg width="${dim}" height="${dim}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${spessore}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONE[nome]}</svg>`;
}

// Evita che un nome come "<b>" venga interpretato come HTML
function esc(testo) {
  return String(testo).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const plurale = (n, uno, tanti) => n + " " + (n === 1 ? uno : tanti);

function miniatura(id, icona) {
  const url = id && urlFoto.get(id);
  return `<span class="mini">${url ? `<img src="${url}" alt="">` : ico(icona, 22)}</span>`;
}

function immagineScheda(id, icona) {
  const url = urlFoto.get(id);
  return `<div class="card-img">${url ? `<img src="${url}" alt="" loading="lazy">` : ico(icona, 48, 1.4)}</div>`;
}

function hero(id) {
  const url = urlFoto.get(id);
  return url ? `<div class="hero"><img src="${url}" alt=""></div>` : "";
}

function testoStato(oggetto) {
  return `<span class="stato ${oggetto.tascaId ? "dentro" : ""}">${esc(posizione(oggetto))}</span>`;
}

// Opzioni "Fuori" + tutte le tasche, raggruppate per zaino
function opzioniPosizione(selezionata) {
  const gruppi = [...dati.zaini].sort(perNome).map(z => {
    const opz = tascheDi(z.id).sort(perNome).map(t =>
      `<option value="${t.id}" ${t.id === selezionata ? "selected" : ""}>${esc(t.nome)}</option>`).join("");
    return opz ? `<optgroup label="${esc(z.nome)}">${opz}</optgroup>` : "";
  }).join("");
  return `<option value="" ${selezionata ? "" : "selected"}>Fuori dallo zaino</option>${gruppi}`;
}

function bloccoTag(tipo, id) {
  const url = indirizzoTag(tipo, id);
  return `
    <h2>Tag NFC</h2>
    <ul class="lista senza-mini">
      <li><div class="codice">${esc(url)}</div></li>
      <li><button class="riga aggiungi" data-azione="copia" data-testo="${esc(url)}">${ico("nfc", 22)}<span class="riga-testo"><span>Copia indirizzo per il tag</span></span></button></li>
    </ul>
    <p class="nota">Apri NFC Tools → Scrivi → Aggiungi un record → URL, incolla l'indirizzo e avvicina il tag.</p>`;
}

/* ---------- Messaggio temporaneo ---------- */
let timerToast;
function mostraToast(testo) {
  const toast = document.getElementById("toast");
  toast.textContent = testo;
  toast.hidden = false;
  toast.style.animation = "none"; void toast.offsetWidth; toast.style.animation = "";
  clearTimeout(timerToast);
  timerToast = setTimeout(() => (toast.hidden = true), 3000);
}

/* ---------- Pannello dal basso ---------- */
function apriSheet(html) {
  const d = document.getElementById("sheet");
  d.querySelector(".sheet-corpo").innerHTML = `<div class="maniglia"></div>${html}`;
  if (!d.open) d.showModal();
  d.scrollTop = 0;
  return d;
}
function chiudiSheet() {
  modulo = null;
  const d = document.getElementById("sheet");
  if (d.open) d.close();
}

// Conferma in stile iOS: restituisce una Promise con true / false
function chiediConferma(messaggio, etichetta) {
  const d = document.getElementById("conferma");
  d.querySelector(".sheet-corpo").innerHTML = `
    <div class="azione-gruppo"><p>${esc(messaggio)}</p><button class="rosso" value="si">${esc(etichetta)}</button></div>
    <div class="azione-gruppo annulla"><button value="no">Annulla</button></div>`;
  d.showModal();
  return new Promise(ok => {
    d.onclick = e => {
      const b = e.target.closest("button");
      if (b || e.target === d) { d.close(); ok(b && b.value === "si"); }
    };
    d.oncancel = () => ok(false);
  });
}

// Tocco sullo sfondo scuro → chiude il pannello
document.getElementById("sheet").addEventListener("click", e => {
  if (e.target.id === "sheet") chiudiSheet();
});
document.getElementById("sheet").addEventListener("close", () => (modulo = null));

/* ---------- Modulo di creazione / modifica ---------- */
// modulo = { tipo, id, foto, lavora, tascaId, zainoId }
//   foto: undefined = invariata, Blob = nuova foto, null = da rimuovere
let modulo = null;
const NOMI = { zaino: "zaino", tasca: "tasca", oggetto: "oggetto" };

function apriModulo(tipo, id = null, extra = {}) {
  const el = id ? trova(tipo, id) : null;
  modulo = { tipo, id, foto: undefined, lavora: false, ...extra };
  const conFoto = tipo !== "tasca";
  const url = id && urlFoto.get(id);
  const segnaposto = `<span class="segnaposto">${ico("foto", 40, 1.5)}Aggiungi foto</span>`;

  apriSheet(`
    <form data-azione="salva-modulo" autocomplete="off">
      <div class="sheet-barra">
        <button type="button" class="btn-nav" data-azione="chiudi-sheet">Annulla</button>
        <b>${id ? "Modifica" : "Nuovo"} ${NOMI[tipo]}</b>
        <button class="btn-nav" id="btn-salva">${id ? "Fine" : "Crea"}</button>
      </div>
      ${conFoto ? `
        <label class="foto-picker" id="foto-picker">
          ${url ? `<img src="${url}" alt="">` : segnaposto}
          <input type="file" accept="image/*" id="input-foto" hidden>
        </label>
        <p class="stato-foto" id="stato-foto">${url ? "Tocca per cambiare foto" :
          dati.impostazioni.rimuoviSfondo ? "Lo sfondo verrà rimosso in automatico" : ""}</p>` : `<div class="spazio"></div>`}
      <ul class="lista senza-mini">
        <li class="campo"><input name="nome" value="${esc(el ? el.nome : "")}" placeholder="Nome ${NOMI[tipo]}" required enterkeyhint="done"></li>
        ${tipo === "oggetto" && !id ? `
        <li class="campo"><label for="sel-pos">Posizione</label>
          <select id="sel-pos" name="tasca">${opzioniPosizione(extra.tascaId || null)}</select></li>` : ""}
      </ul>
      ${conFoto && url ? `<div class="spazio"></div><button type="button" class="btn tenue" data-azione="rimuovi-foto">Rimuovi foto</button>` : ""}
      ${id ? `<div class="spazio"></div><button type="button" class="btn rosso" data-azione="elimina" data-tipo="${tipo}" data-id="${id}">Elimina ${NOMI[tipo]}</button>` : ""}
    </form>`);
}

async function fotoScelta(file) {
  const questo = modulo;
  if (!questo || !file) return;
  const picker = document.getElementById("foto-picker");
  const stato = document.getElementById("stato-foto");
  const salvaBtn = document.getElementById("btn-salva");
  const aggiorna = testo => { if (modulo === questo) stato.textContent = testo; };

  questo.lavora = true;
  picker.classList.add("lavora");
  salvaBtn.disabled = true;
  aggiorna("Preparazione…");
  try {
    const { blob, sfondoRimosso } = await preparaFoto(file, aggiorna);
    if (modulo !== questo) return; // pannello chiuso nel frattempo
    questo.foto = blob;
    const anteprima = URL.createObjectURL(blob);
    picker.querySelector("img, .segnaposto").outerHTML = `<img src="${anteprima}" alt="">`;
    aggiorna(sfondoRimosso ? "Sfondo rimosso ✓" :
      dati.impostazioni.rimuoviSfondo ? "Sfondo non rimosso: uso la foto originale" : "Foto pronta");
  } catch (e) {
    aggiorna("Impossibile leggere questa foto");
  } finally {
    questo.lavora = false;
    picker.classList.remove("lavora");
    salvaBtn.disabled = false;
  }
}

function salvaModulo(form) {
  const m = modulo;
  if (!m || m.lavora) return;
  const nome = form.nome.value.trim();
  if (!nome) return;

  let id = m.id;
  if (id) {
    trova(m.tipo, id).nome = nome;
    salva();
  } else if (m.tipo === "zaino") {
    id = creaZaino(nome).id;
  } else if (m.tipo === "tasca") {
    id = creaTasca(m.zainoId, nome).id;
  } else {
    id = creaOggetto(nome, form.tasca.value || null).id;
  }
  if (m.foto !== undefined) impostaFoto(id, m.foto);

  chiudiSheet();
  if (!m.id && m.tipo === "zaino") location.hash = "#/zaino/" + id;
  else if (!m.id) mostraToast(NOMI[m.tipo][0].toUpperCase() + NOMI[m.tipo].slice(1) + " creato: " + nome);
  render();
}

/* ---------- Selezione multipla: metti oggetti in una tasca ---------- */
function apriMettiQui(tascaId) {
  const tasca = trovaTasca(tascaId);
  const altri = dati.oggetti.filter(o => o.tascaId !== tascaId).sort(perNome);
  const righe = altri.map(o => `
    <li><label class="riga">
      <input type="checkbox" name="o" value="${o.id}">
      ${miniatura(o.id, "scatola")}
      <span class="riga-testo"><span>${esc(o.nome)}</span><small>${esc(posizione(o))}</small></span>
      <span class="spunta">${ico("spunta", 16, 2.5)}</span>
    </label></li>`).join("");
  apriSheet(`
    <form data-azione="conferma-metti" data-id="${tascaId}">
      <div class="sheet-barra">
        <button type="button" class="btn-nav" data-azione="chiudi-sheet">Annulla</button>
        <b>${esc(tasca.nome)}</b>
        <button class="btn-nav">Metti</button>
      </div>
      ${altri.length ? `<ul class="lista">${righe}</ul>
        <p class="nota">Seleziona gli oggetti da mettere in questa tasca.</p>`
        : `<p class="nota centro">Non ci sono altri oggetti nell'inventario.</p>`}
      <div class="spazio"></div>
      <button type="button" class="btn tenue" data-azione="nuovo" data-tipo="oggetto" data-tasca="${tascaId}">${ico("piu", 20)} Nuovo oggetto</button>
    </form>`);
}

/* =========================================================
   5. SCHERMATE
   Ogni funzione "vista..." restituisce un oggetto con:
     titolo, indietro (link e testo), destra (pulsante), html
   La schermata dipende dalla parte dopo # nell'indirizzo:
     #/             → zaini           #/inventario   → tutti gli oggetti
     #/zaino/ID     → uno zaino       #/oggetto/ID   → un oggetto
     #/tasca/ID     → una tasca       #/impostazioni → impostazioni
   ========================================================= */

const pulsantePiu = (tipo, extra = "") =>
  `<button class="btn-nav tondo" data-azione="nuovo" data-tipo="${tipo}" ${extra} aria-label="Nuovo">${ico("piu", 24, 2)}</button>`;
const pulsanteModifica = (tipo, id) =>
  `<button class="btn-nav" data-azione="modifica" data-tipo="${tipo}" data-id="${id}">Modifica</button>`;

function vistaZaini() {
  const zaini = [...dati.zaini].sort(perNome);
  const schede = zaini.map(z => `
    <a class="card" href="#/zaino/${z.id}">
      ${immagineScheda(z.id, "zaino")}
      <div class="card-testo"><b>${esc(z.nome)}</b>
        <small>${plurale(oggettiInZaino(z.id).length, "oggetto", "oggetti")} · ${plurale(tascheDi(z.id).length, "tasca", "tasche")}</small></div>
    </a>`).join("");
  return {
    titolo: "Zaini",
    destra: pulsantePiu("zaino"),
    html: zaini.length ? `<div class="griglia">${schede}</div>` : `
      <div class="vuoto">${ico("zaino", 64, 1.2)}<b>Nessuno zaino</b>
        <span>Crea il tuo primo zaino, poi aggiungi le tasche.</span>
        <button class="btn" data-azione="nuovo" data-tipo="zaino">Crea zaino</button></div>`
  };
}

function vistaZaino(id) {
  const zaino = trovaZaino(id);
  if (!zaino) return nonTrovato();
  const tasche = tascheDi(id).sort(perNome);
  const righeTasche = tasche.map(t => `
    <li><a class="riga" href="#/tasca/${t.id}">
      ${miniatura(null, "tasca")}
      <span class="riga-testo"><span>${esc(t.nome)}</span></span>
      <span class="valore">${oggettiIn(t.id).length}</span>${ico("avanti", 18, 2.2).replace("<svg", '<svg class="chevron"')}
    </a></li>`).join("");

  const contenuto = oggettiInZaino(id).sort(perNome);
  const righeContenuto = contenuto.map(o => `
    <li><a class="riga" href="#/oggetto/${o.id}">
      ${miniatura(o.id, "scatola")}
      <span class="riga-testo"><span>${esc(o.nome)}</span><small>${esc(trovaTasca(o.tascaId).nome)}</small></span>
      ${ico("avanti", 18, 2.2).replace("<svg", '<svg class="chevron"')}
    </a></li>`).join("");

  return {
    titolo: zaino.nome,
    indietro: { href: "#/", testo: "Zaini" },
    destra: pulsanteModifica("zaino", id),
    html: `
      ${hero(id)}
      <h2>Tasche</h2>
      <ul class="lista">
        ${righeTasche}
        <li><button class="riga aggiungi" data-azione="nuovo" data-tipo="tasca" data-zaino="${id}">
          ${miniatura(null, "piu")}<span class="riga-testo"><span>Aggiungi tasca</span></span></button></li>
      </ul>
      <h2>Contenuto · ${plurale(contenuto.length, "oggetto", "oggetti")}</h2>
      ${contenuto.length ? `<ul class="lista">${righeContenuto}</ul>` :
        `<ul class="lista"><li class="vuoto-riga">Lo zaino è vuoto.</li></ul>`}`
  };
}

function vistaTasca(id) {
  const tasca = trovaTasca(id);
  if (!tasca) return nonTrovato();
  const zaino = trovaZaino(tasca.zainoId);
  const dentro = oggettiIn(id).sort(perNome);

  const righe = dentro.map(o => `
    <li><div class="riga">
      <a class="riga-testo" href="#/oggetto/${o.id}" style="flex-direction:row;align-items:center;gap:12px;color:inherit;text-decoration:none">
        ${miniatura(o.id, "scatola")}<span class="riga-testo"><span>${esc(o.nome)}</span></span></a>
      <button class="btn-piccolo" data-azione="togli" data-id="${o.id}">Togli</button>
    </div></li>`).join("");

  return {
    titolo: tasca.nome,
    indietro: { href: "#/zaino/" + tasca.zainoId, testo: zaino ? zaino.nome : "Zaino" },
    destra: pulsanteModifica("tasca", id),
    html: `
      <p class="sottotitolo">${esc(zaino ? zaino.nome : "")}</p>
      <h2>Contenuto</h2>
      <ul class="lista">
        ${righe || `<li class="vuoto-riga">Tasca vuota.</li>`}
        <li><button class="riga aggiungi" data-azione="metti-qui" data-id="${id}">
          ${miniatura(null, "piu")}<span class="riga-testo"><span>Metti oggetti</span></span></button></li>
      </ul>
      ${bloccoTag("t", id)}`
  };
}

let filtroInventario = "tutti";

function vistaInventario() {
  const oggetti = [...dati.oggetti].sort(perNome);
  const schede = oggetti.map(o => `
    <a class="card" href="#/oggetto/${o.id}" data-nome="${esc(o.nome.toLowerCase())}" data-stato="${o.tascaId ? "dentro" : "fuori"}">
      ${immagineScheda(o.id, "scatola")}
      <div class="card-testo"><b>${esc(o.nome)}</b><small class="stato ${o.tascaId ? "dentro" : ""}">${esc(o.tascaId ? trovaTasca(o.tascaId).nome : "Fuori")}</small></div>
    </a>`).join("");
  const nDentro = oggetti.filter(o => o.tascaId).length;
  const seg = (val, testo) =>
    `<button class="${filtroInventario === val ? "attivo" : ""}" data-azione="filtro" data-valore="${val}">${testo}</button>`;

  return {
    titolo: "Inventario",
    destra: pulsantePiu("oggetto"),
    html: oggetti.length ? `
      <label class="cerca">${ico("lente", 18, 2)}<input id="cerca" type="search" placeholder="Cerca" enterkeyhint="search"></label>
      <div class="segmenti">${seg("tutti", "Tutti " + oggetti.length)}${seg("dentro", "Dentro " + nDentro)}${seg("fuori", "Fuori " + (oggetti.length - nDentro))}</div>
      <div class="griglia" id="griglia-oggetti">${schede}</div>
      <p class="nota centro" id="nessun-risultato" hidden>Nessun oggetto trovato.</p>` : `
      <div class="vuoto">${ico("scatola", 64, 1.2)}<b>Inventario vuoto</b>
        <span>Aggiungi gli oggetti che porti nello zaino.</span>
        <button class="btn" data-azione="nuovo" data-tipo="oggetto">Aggiungi oggetto</button></div>`
  };
}

// Mostra solo gli oggetti che corrispondono a ricerca e filtro
function applicaFiltri() {
  const campo = document.getElementById("cerca");
  const griglia = document.getElementById("griglia-oggetti");
  if (!griglia) return;
  const q = campo ? campo.value.trim().toLowerCase() : "";
  let visibili = 0;
  griglia.querySelectorAll(".card").forEach(c => {
    const ok = c.dataset.nome.includes(q) && (filtroInventario === "tutti" || c.dataset.stato === filtroInventario);
    c.hidden = !ok;
    if (ok) visibili++;
  });
  document.getElementById("nessun-risultato").hidden = visibili > 0;
}

function vistaOggetto(id) {
  const oggetto = trovaOggetto(id);
  if (!oggetto) return nonTrovato();
  return {
    titolo: oggetto.nome,
    indietro: { href: "#/inventario", testo: "Inventario" },
    destra: pulsanteModifica("oggetto", id),
    html: `
      ${hero(id)}
      <h2>Posizione</h2>
      <ul class="lista senza-mini">
        <li class="campo">${testoStato(oggetto)}</li>
        <li class="campo"><label for="sposta">Sposta in</label>
          <select id="sposta" data-azione="sposta-oggetto" data-id="${id}">${opzioniPosizione(oggetto.tascaId)}</select></li>
      </ul>
      ${oggetto.tascaId ? `<div class="spazio"></div><button class="btn tenue" data-azione="togli" data-id="${id}">Togli dallo zaino</button>` : ""}
      ${bloccoTag("o", id)}`
  };
}

function vistaImpostazioni() {
  return {
    titolo: "Impostazioni",
    html: `
      <h2>Foto</h2>
      <ul class="lista senza-mini">
        <li class="campo"><label for="sw-sfondo" style="flex:1">Rimuovi sfondo automaticamente</label>
          <input type="checkbox" class="switch" id="sw-sfondo" data-azione="sfondo" ${dati.impostazioni.rimuoviSfondo ? "checked" : ""}></li>
      </ul>
      <p class="nota">L'elaborazione avviene sul tuo iPhone: le foto non vengono inviate a nessun server. La prima volta viene scaricato il modello di intelligenza artificiale (circa 40 MB).</p>

      <h2>Backup</h2>
      <ul class="lista senza-mini">
        <li><button class="riga aggiungi" data-azione="esporta">Esporta backup</button></li>
        <li><button class="riga aggiungi" data-azione="importa">Importa backup</button></li>
      </ul>
      <input id="file-backup" type="file" accept="application/json,.json" hidden>
      <p class="nota">I dati sono salvati solo in Safari su questo iPhone. Safari può cancellarli se non apri l'app per 7 giorni: esporta un backup ogni tanto. Il backup include le foto.</p>

      <h2>Riepilogo</h2>
      <ul class="lista senza-mini">
        <li class="campo"><span style="flex:1">Zaini</span><span class="valore">${dati.zaini.length}</span></li>
        <li class="campo"><span style="flex:1">Tasche</span><span class="valore">${dati.tasche.length}</span></li>
        <li class="campo"><span style="flex:1">Oggetti</span><span class="valore">${dati.oggetti.length}</span></li>
      </ul>`
  };
}

function nonTrovato() {
  return { titolo: "Non trovato", indietro: { href: "#/", testo: "Zaini" },
    html: `<div class="vuoto"><b>Elemento non trovato</b><span>Potrebbe essere stato eliminato.</span></div>` };
}

/* ---------- Disegno della schermata ---------- */
let ultimaVista = "";

function render() {
  const [, sezione = "", id] = (location.hash || "#/").split("/");
  const viste = {
    "": vistaZaini, zaino: vistaZaino, tasca: vistaTasca,
    inventario: vistaInventario, oggetto: vistaOggetto, impostazioni: vistaImpostazioni
  };
  const vista = (viste[sezione] || vistaZaini)(id);

  // Barra in alto
  document.getElementById("nav-titolo").textContent = vista.titolo;
  document.getElementById("nav-dx").innerHTML = vista.destra || "";
  const indietro = document.getElementById("indietro");
  indietro.hidden = !vista.indietro;
  if (vista.indietro) {
    indietro.href = vista.indietro.href;
    indietro.innerHTML = ico("indietro", 26, 2.2) + `<span>${esc(vista.indietro.testo)}</span>`;
  }
  document.title = vista.titolo + " · Zaino";

  // Contenuto (cambiando schermata si torna in cima)
  const ricerca = document.getElementById("cerca");
  const testoRicerca = ricerca ? ricerca.value : "";
  document.getElementById("app").innerHTML =
    `<h1 class="titolo-grande">${esc(vista.titolo)}</h1>${vista.html}`;
  const chiave = sezione + "/" + (id || "");
  if (chiave !== ultimaVista) { window.scrollTo(0, 0); ultimaVista = chiave; }
  else if (document.getElementById("cerca")) document.getElementById("cerca").value = testoRicerca;
  applicaFiltri();
  aggiornaScroll();

  // Barra delle schede
  const scheda = { "": "zaini", zaino: "zaini", tasca: "zaini",
    inventario: "inventario", oggetto: "inventario", impostazioni: "impostazioni" }[sezione] || "zaini";
  const tab = (nome, href, icona, testo) =>
    `<a href="${href}" class="${scheda === nome ? "attivo" : ""}">${ico(icona, 26, scheda === nome ? 2 : 1.6)}${testo}</a>`;
  document.getElementById("tabbar").innerHTML =
    tab("zaini", "#/", "zaino", "Zaini") +
    tab("inventario", "#/inventario", "scatola", "Inventario") +
    tab("impostazioni", "#/impostazioni", "regola", "Impostazioni");

  renderBanner();
}

function renderBanner() {
  const banner = document.getElementById("tasca-attiva");
  const attiva = tascaAttiva();
  banner.hidden = !attiva;
  if (attiva) {
    const secondi = Math.ceil((dati.tascaAttiva.scade - Date.now()) / 1000);
    const testo = `<span>${ico("nfc", 18, 2).replace("<svg", '<svg style="display:inline;vertical-align:-3px"')} <b>${esc(attiva.nome)}</b> attiva · ${secondi}s</span>`;
    if (!banner.querySelector("button")) {
      banner.innerHTML = `<span class="testo"></span><button class="btn-piccolo" data-azione="annulla-tasca">Fine</button>`;
    }
    banner.querySelector(".testo").innerHTML = testo;
  }
}

// Titolo piccolo e barra "vetro" quando si scorre la pagina
function aggiornaScroll() {
  document.body.classList.toggle("scrollato", window.scrollY > 30);
}
window.addEventListener("scroll", aggiornaScroll, { passive: true });

/* =========================================================
   6. AZIONI DELL'UTENTE
   Invece di collegare ogni pulsante, ascoltiamo tutta la pagina
   ("delegazione degli eventi") e leggiamo l'attributo data-azione.
   ========================================================= */

document.addEventListener("submit", e => {
  const form = e.target;
  if (!form.dataset.azione) return;
  e.preventDefault();

  if (form.dataset.azione === "salva-modulo") salvaModulo(form);

  if (form.dataset.azione === "conferma-metti") {
    const tasca = trovaTasca(form.dataset.id);
    const scelti = [...form.querySelectorAll("input[name=o]:checked")].map(i => trovaOggetto(i.value));
    scelti.forEach(o => sposta(o, tasca.id));
    chiudiSheet();
    if (scelti.length) mostraToast(plurale(scelti.length, "oggetto messo", "oggetti messi") + " in " + tasca.nome);
    render();
  }
});

document.addEventListener("click", async e => {
  const el = e.target.closest("button[data-azione]");
  if (!el) return;
  const { id, tipo } = el.dataset;

  switch (el.dataset.azione) {
    case "nuovo":
      apriModulo(tipo, null, { zainoId: el.dataset.zaino, tascaId: el.dataset.tasca });
      return;
    case "modifica":
      apriModulo(tipo, id);
      return;
    case "chiudi-sheet":
      chiudiSheet();
      return;
    case "rimuovi-foto":
      if (modulo) {
        modulo.foto = null;
        document.getElementById("foto-picker").querySelector("img").outerHTML =
          `<span class="segnaposto">${ico("foto", 40, 1.5)}Aggiungi foto</span>`;
        document.getElementById("stato-foto").textContent = "La foto verrà rimossa";
        el.hidden = true;
      }
      return;
    case "elimina": {
      const messaggi = {
        zaino: "Le tasche verranno eliminate. Gli oggetti resteranno nell'inventario, \"fuori\".",
        tasca: "Gli oggetti contenuti finiranno \"fuori\".",
        oggetto: "L'oggetto verrà tolto dall'inventario."
      };
      if (!(await chiediConferma(messaggi[tipo], "Elimina " + NOMI[tipo]))) return;
      const tasca = tipo === "tasca" && trovaTasca(id);
      if (tipo === "zaino") { eliminaZaino(id); location.hash = "#/"; }
      if (tipo === "tasca") { eliminaTasca(id); location.hash = "#/zaino/" + tasca.zainoId; }
      if (tipo === "oggetto") { eliminaOggetto(id); location.hash = "#/inventario"; }
      chiudiSheet();
      break;
    }
    case "togli": {
      const o = trovaOggetto(id);
      sposta(o, null);
      mostraToast(o.nome + " tolto");
      break;
    }
    case "metti-qui":
      apriMettiQui(id);
      return;
    case "filtro":
      filtroInventario = el.dataset.valore;
      break;
    case "copia":
      copia(el.dataset.testo);
      return;
    case "annulla-tasca":
      dati.tascaAttiva = null;
      salva();
      break;
    case "esporta":
      esportaBackup();
      return;
    case "importa":
      document.getElementById("file-backup").click();
      return;
  }
  render();
});

document.addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.azione === "sposta-oggetto") {
    const o = trovaOggetto(el.dataset.id);
    sposta(o, el.value || null);
    mostraToast(o.nome + " → " + posizione(o));
    render();
  }
  if (el.dataset.azione === "sfondo") {
    dati.impostazioni.rimuoviSfondo = el.checked;
    salva();
  }
  if (el.id === "input-foto") fotoScelta(el.files[0]);
  if (el.id === "file-backup" && el.files[0]) importaBackup(el.files[0]);
});

document.addEventListener("input", e => {
  if (e.target.id === "cerca") applicaFiltri();
});

function copia(testo) {
  const ripiego = () => prompt("Copia questo indirizzo:", testo);
  if (navigator.clipboard) {
    navigator.clipboard.writeText(testo).then(() => mostraToast("Indirizzo copiato"), ripiego);
  } else ripiego();
}

/* ---------- Backup (dati + foto in un unico file) ---------- */
const blobInTesto = blob => new Promise(ok => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.readAsDataURL(blob);
});

async function esportaBackup() {
  const foto = {};
  const tutte = await leggiTutteLeFoto();
  for (const [id, blob] of Object.entries(tutte)) foto[id] = await blobInTesto(blob);
  const contenuto = JSON.stringify({ versione: 2, ...dati, foto });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contenuto], { type: "application/json" }));
  a.download = "zaino-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importaBackup(file) {
  const lettore = new FileReader();
  lettore.onload = async () => {
    try {
      const nuovi = JSON.parse(lettore.result);
      if (!Array.isArray(nuovi.zaini) || !Array.isArray(nuovi.tasche) || !Array.isArray(nuovi.oggetti)) throw 0;
      if (!(await chiediConferma("Tutti i dati attuali verranno sostituiti da quelli del backup.", "Sostituisci"))) return;
      const foto = nuovi.foto || {};
      delete nuovi.foto; delete nuovi.versione;
      dati = Object.assign(datiVuoti(), nuovi);
      dati.impostazioni = Object.assign(datiVuoti().impostazioni, nuovi.impostazioni);
      salva();
      await operazioneDb("readwrite", s => s.clear());
      [...urlFoto.keys()].forEach(id => mettiInCache(id, null));
      for (const [id, testo] of Object.entries(foto)) {
        await impostaFoto(id, await (await fetch(testo)).blob());
      }
      mostraToast("Backup importato");
      render();
    } catch (e) {
      mostraToast("File di backup non valido");
    }
  };
  lettore.readAsText(file);
}

/* =========================================================
   7. AVVIO
   ========================================================= */
window.addEventListener("hashchange", () => { chiudiSheet(); render(); });
// Tornando a una scheda di Safari già aperta, rileggi i dati (un tag può averli cambiati)
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !modulo) { dati = carica(); render(); }
});
setInterval(renderBanner, 1000); // aggiorna il conto alla rovescia

gestisciTag();
render();

// Le foto si caricano dal database in un secondo momento
leggiTutteLeFoto()
  .then(tutte => { Object.entries(tutte).forEach(([id, blob]) => mettiInCache(id, blob)); render(); })
  .catch(() => {});

// Chiede a Safari di non cancellare i dati (non sempre viene concesso)
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
