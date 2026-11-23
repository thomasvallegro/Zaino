/* =========================================================
   ZAINO · logica dell'app
   I dati stanno su Firebase (vedi db.js): così Safari (aperto
   dai tag NFC) e la web app sulla schermata Home vedono lo
   stesso inventario.
   ========================================================= */

import * as cloud from "./db.js";

/* =========================================================
   1. DATI
   "dati" è una copia in memoria del database: viene aggiornata
   in tempo reale da Firebase. Ogni modifica cambia subito la copia
   (così l'interfaccia risponde all'istante) e la invia al database.
   ========================================================= */

const DURATA_TASCA_ATTIVA = 2 * 60 * 1000; // 2 minuti, in millisecondi

function datiVuoti() {
  return {
    zaini: [],   // { id, nome }
    tasche: [],  // { id, nome, zainoId }
    oggetti: [], // { id, nome, tascaId, ultimaTascaId }  tascaId = null → "fuori"
    tascaAttiva: null // { tascaId, scade } dopo aver letto il tag di una tasca
  };
}

let dati = datiVuoti();
let utente;            // undefined = non ancora noto, null = non collegato
let caricato = false;  // true quando i dati sono arrivati dal database
let smettiDiAscoltare = null;

// Impostazioni di questo dispositivo (non sincronizzate)
const CHIAVE_IMPOSTAZIONI = "zaino-impostazioni";
const impostazioni = (() => {
  try { return Object.assign({ rimuoviSfondo: true }, JSON.parse(localStorage.getItem(CHIAVE_IMPOSTAZIONI))); }
  catch (e) { return { rimuoviSfondo: true }; }
})();
function salvaImpostazioni() {
  try { localStorage.setItem(CHIAVE_IMPOSTAZIONI, JSON.stringify(impostazioni)); } catch (e) {}
}

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

/* ---------- Invio al database ----------
   Ogni scrittura viene "registrata" per mostrare lo stato
   della sincronizzazione (es. "Offline") e gli eventuali errori. */
let scrittureInCorso = 0;

function registra(promessa) {
  scrittureInCorso++;
  aggiornaSync();
  promessa
    .catch(e => { console.error(e); mostraToast("Errore di salvataggio: " + (e.code || e.message)); })
    .finally(() => { scrittureInCorso--; aggiornaSync(); });
  return promessa;
}
const salvaDoc   = (collezione, elemento) => registra(cloud.scrivi(utente.uid, collezione, elemento));
const eliminaDoc = (collezione, id) => registra(cloud.cancella(utente.uid, collezione, id));
const inBlocco   = operazioni => registra(cloud.inBlocco(utente.uid, operazioni));

/* ---------- Modifiche ---------- */
function creaZaino(nome) {
  const zaino = { id: nuovoId(), nome };
  dati.zaini.push(zaino);
  salvaDoc("zaini", zaino);
  return zaino;
}

function eliminaZaino(id) {
  const operazioni = tascheDi(id).flatMap(t => operazioniEliminaTasca(t.id));
  dati.zaini = dati.zaini.filter(z => z.id !== id);
  operazioni.push(["delete", "zaini", id]);
  if (urlFoto.has(id)) { urlFoto.delete(id); operazioni.push(["delete", "foto", id]); }
  inBlocco(operazioni);
}

function creaTasca(zainoId, nome) {
  const tasca = { id: nuovoId(), nome, zainoId };
  dati.tasche.push(tasca);
  salvaDoc("tasche", tasca);
  return tasca;
}

// Eliminando una tasca, i suoi oggetti finiscono "fuori".
// Restituisce l'elenco delle scritture da fare sul database.
function operazioniEliminaTasca(id) {
  const operazioni = [];
  dati.oggetti.forEach(o => {
    if (o.tascaId !== id && o.ultimaTascaId !== id) return;
    if (o.tascaId === id) o.tascaId = null;
    if (o.ultimaTascaId === id) o.ultimaTascaId = null;
    operazioni.push(["set", "oggetti", o]);
  });
  if (dati.tascaAttiva && dati.tascaAttiva.tascaId === id) {
    dati.tascaAttiva = null;
    operazioni.push(["delete", "stato", "tascaAttiva"]);
  }
  dati.tasche = dati.tasche.filter(t => t.id !== id);
  operazioni.push(["delete", "tasche", id]);
  return operazioni;
}
const eliminaTasca = id => inBlocco(operazioniEliminaTasca(id));

function creaOggetto(nome, tascaId = null) {
  const oggetto = { id: nuovoId(), nome, tascaId, ultimaTascaId: tascaId };
  dati.oggetti.push(oggetto);
  salvaDoc("oggetti", oggetto);
  return oggetto;
}

// Sposta un oggetto in una tasca (o fuori, con tascaId = null)
function sposta(oggetto, tascaId) {
  oggetto.tascaId = tascaId;
  if (tascaId) oggetto.ultimaTascaId = tascaId; // ricorda dove stava
  return salvaDoc("oggetti", oggetto);
}

function eliminaOggetto(id) {
  dati.oggetti = dati.oggetti.filter(o => o.id !== id);
  const operazioni = [["delete", "oggetti", id]];
  if (urlFoto.has(id)) { urlFoto.delete(id); operazioni.push(["delete", "foto", id]); }
  inBlocco(operazioni);
}

function impostaTascaAttiva(tascaId) {
  if (tascaId) {
    dati.tascaAttiva = { tascaId, scade: Date.now() + DURATA_TASCA_ATTIVA };
    salvaDoc("stato", { id: "tascaAttiva", ...dati.tascaAttiva });
  } else {
    dati.tascaAttiva = null;
    eliminaDoc("stato", "tascaAttiva");
  }
}

/* =========================================================
   2. FOTO
   - Salvate nel database come testo (data URL), una per documento.
   - Prima di salvarle: rimpicciolite, sfondo rimosso, ritagliate.
   ========================================================= */

// id → immagine (data URL), pronta da usare in <img src="...">
const urlFoto = new Map();

// Salva (testo) o elimina (null) la foto di uno zaino / oggetto
function impostaFoto(id, testo) {
  if (testo) {
    urlFoto.set(id, testo);
    aggiornaColori();
    return salvaDoc("foto", { id, dati: testo });
  }
  urlFoto.delete(id);
  return eliminaDoc("foto", id);
}

const blobInTesto = blob => new Promise((ok, ko) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => ko(r.error);
  r.readAsDataURL(blob);
});

// Un documento di Firestore può pesare al massimo 1 MB:
// se la foto è troppo grande la rimpiccioliamo ancora
async function fotoPerDatabase(blob) {
  let testo = await blobInTesto(blob);
  for (const lato of [300, 220]) {
    if (testo.length < 700_000) break;
    testo = await blobInTesto(await ridimensiona(blob, lato, blob.type === "image/png" ? "image/png" : "image/jpeg"));
  }
  return testo;
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
  if (impostazioni.rimuoviSfondo) {
    try {
      aggiornaStato("Rimozione dello sfondo…");
      const senzaSfondo = await rimuoviSfondo(base, aggiornaStato);
      aggiornaStato("Rifinitura…");
      return { blob: await ritagliaTrasparenza(senzaSfondo, 400), sfondoRimosso: true };
    } catch (e) {
      console.warn("Rimozione sfondo non riuscita:", e);
    }
  }
  return { blob: await ridimensiona(base, 400, "image/jpeg"), sfondoRimosso: false };
}


/* =========================================================
   3. TAG NFC
   Su ogni tag si scrive un indirizzo come
     https://.../Zaino/?tag=o-ID   (oggetto)
     https://.../Zaino/?tag=t-ID   (tasca)
   iPhone lo legge da solo e apre la pagina in Safari: qui la gestiamo.
   ========================================================= */

// Il tag viene letto subito, ma eseguito solo dopo login e caricamento dati
let tagInAttesa = new URLSearchParams(location.search).get("tag");
if (tagInAttesa) history.replaceState(null, "", location.pathname + location.hash);

function indirizzoTag(tipo, id) {
  return location.origin + location.pathname + "?tag=" + tipo + "-" + id;
}

function tascaAttiva() {
  const ta = dati.tascaAttiva;
  if (ta && ta.scade > Date.now() && trovaTasca(ta.tascaId)) return trovaTasca(ta.tascaId);
  return null;
}

// Mostra l'esito; quando il database conferma, aggiunge "✓"
function esito(testo, promessa) {
  mostraToast(testo + (navigator.onLine ? "" : " · offline, verrà salvato appena torna la rete"));
  if (promessa) promessa.then(() => mostraToast(testo + " ✓"), () => {});
}

function gestisciTag(tag) {
  const trattino = tag.indexOf("-");
  const tipo = tag.slice(0, trattino);
  const id = tag.slice(trattino + 1);

  if (tipo === "t") {
    const tasca = trovaTasca(id);
    if (!tasca) return mostraToast("Tag non riconosciuto");
    impostaTascaAttiva(id);
    location.hash = "#/tasca/" + id;
    return mostraScena({ tipo: "tasca", tasca });
  }

  if (tipo === "o") {
    const oggetto = trovaOggetto(id);
    if (!oggetto) return mostraToast("Tag non riconosciuto");
    const attiva = tascaAttiva();

    if (attiva) {
      // C'è una tasca selezionata → l'oggetto va lì (e i 2 minuti ripartono)
      impostaTascaAttiva(attiva.id);
      location.hash = "#/tasca/" + attiva.id;
      if (oggetto.tascaId === attiva.id) return mostraScena({ tipo: "gia", oggetto, tasca: attiva });
      return mostraScena({ tipo: "dentro", oggetto, tasca: attiva, promessa: sposta(oggetto, attiva.id) });
    }

    // Nessuna tasca selezionata → dentro/fuori
    location.hash = "#/oggetto/" + id;
    if (oggetto.tascaId) {
      const eraIn = trovaTasca(oggetto.tascaId);
      return mostraScena({ tipo: "fuori", oggetto, tasca: eraIn, promessa: sposta(oggetto, null) });
    }
    const ultima = oggetto.ultimaTascaId && trovaTasca(oggetto.ultimaTascaId);
    if (ultima) return mostraScena({ tipo: "dentro", oggetto, tasca: ultima, promessa: sposta(oggetto, ultima.id) });
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
  lente: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  utente: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
  menu: '<path d="M4 7h16M4 12h10M4 17h16"/>',
  esci: '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14M9.5 8 5.5 12l4 4M5.5 12H15"/>'
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
//   foto: undefined = invariata, testo (data URL) = nuova foto, null = da rimuovere
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
          impostazioni.rimuoviSfondo ? "Lo sfondo verrà rimosso in automatico" : ""}</p>` : `<div class="spazio"></div>`}
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
    questo.foto = await fotoPerDatabase(blob);
    if (modulo !== questo) return;
    picker.querySelector("img, .segnaposto").outerHTML = `<img src="${questo.foto}" alt="">`;
    aggiorna(sfondoRimosso ? "Sfondo rimosso ✓" :
      impostazioni.rimuoviSfondo ? "Sfondo non rimosso: uso la foto originale" : "Foto pronta");
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
    const el = trova(m.tipo, id);
    el.nome = nome;
    salvaDoc({ zaino: "zaini", tasca: "tasche", oggetto: "oggetti" }[m.tipo], el);
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

/* ---------- Colore dominante delle foto ----------
   Da ogni foto ricaviamo una tinta (h = tonalità, s = saturazione)
   usata per colorare la card che la contiene. */
const coloreFoto = new Map(); // id → { h, s, src }
const inCalcolo = new Set();

async function calcolaColore(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 24, 24);
  const p = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, b = 0, peso = 0;
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] < 200) continue; // salta lo sfondo trasparente
    const vivacita = Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]);
    const w = 1 + vivacita / 24;  // i colori vivaci contano di più
    r += p[i] * w; g += p[i + 1] * w; b += p[i + 2] * w; peso += w;
  }
  if (!peso) return null;
  r /= peso * 255; g /= peso * 255; b /= peso * 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(Math.min(70, Math.max(8, s * 100))) };
}

function aggiornaColori() {
  urlFoto.forEach((src, id) => {
    const noto = coloreFoto.get(id);
    if ((noto && noto.src === src) || inCalcolo.has(id)) return;
    inCalcolo.add(id);
    calcolaColore(src)
      .then(c => { if (c) { coloreFoto.set(id, { ...c, src }); prenotaRender(); } })
      .catch(() => {})
      .finally(() => inCalcolo.delete(id));
  });
}

const tinta = id => {
  const c = coloreFoto.get(id);
  return c ? `--h:${c.h};--s:${c.s};` : "";
};

// Foto con "nome di transizione": vola da una schermata all'altra
function fotoAnimata(id, icona, dimIcona = 56) {
  const url = urlFoto.get(id);
  return url
    ? `<img src="${url}" alt="" style="view-transition-name:f-${id}">`
    : `<span class="segnaposto-ico">${ico(icona, dimIcona, 1.3)}</span>`;
}

/* ---------- Card di un oggetto ---------- */
function cardOggetto(o, i, sotto, conTogli = false) {
  const card = `
    <a class="card-ogg card-anim tinta ${o.tascaId ? "" : "fuori"}" href="#/oggetto/${o.id}" draggable="false"
       style="${tinta(o.id)}--i:${i}" data-nome="${esc(o.nome.toLowerCase())}" data-stato="${o.tascaId ? "dentro" : "fuori"}">
      <span class="lucentezza"></span><div class="card-ogg-img bagliore">${fotoAnimata(o.id, "scatola")}</div>
      <div class="card-ogg-testo">
        <b>${esc(o.nome)}</b>
        <span class="pill ${o.tascaId ? "dentro" : ""}">${esc(sotto)}</span>
      </div>
    </a>`;
  return conTogli
    ? `<div class="card-wrap" style="--i:${i}">${card}
         <button class="btn-togli" data-azione="togli" data-id="${o.id}" aria-label="Togli ${esc(o.nome)}">${ico("x", 16, 2.6)}</button></div>`
    : card;
}

const nomeTascaBreve = o => (o.tascaId && trovaTasca(o.tascaId) ? trovaTasca(o.tascaId).nome : "Fuori");

/* ---------- Schermate ---------- */
function vistaZaini() {
  const zaini = [...dati.zaini].sort(perNome);
  const schede = zaini.map((z, i) => {
    const contenuto = oggettiInZaino(z.id);
    const avatar = contenuto.slice(0, 4).map(o =>
      `<span>${urlFoto.get(o.id) ? `<img src="${urlFoto.get(o.id)}" alt="">` : ico("scatola", 16, 1.8)}</span>`).join("");
    const extra = contenuto.length > 4 ? `<span class="piu">+${contenuto.length - 4}</span>` : "";
    return `
      <a class="card-zaino card-anim tinta" href="#/zaino/${z.id}" draggable="false" style="${tinta(z.id)}--i:${i}">
        <span class="lucentezza"></span><div class="card-zaino-img bagliore">${fotoAnimata(z.id, "zaino", 88)}</div>
        <div class="card-zaino-info">
          <div><b>${esc(z.nome)}</b>
            <span>${plurale(contenuto.length, "oggetto", "oggetti")} · ${plurale(tascheDi(z.id).length, "tasca", "tasche")}</span></div>
          <div class="avatar-stack">${avatar}${extra}</div>
        </div>
      </a>`;
  }).join("");
  return {
    titolo: "Zaini",
    destra: pulsantePiu("zaino"),
    html: zaini.length ? `<div class="griglia-zaini">${schede}</div>` : `
      <div class="vuoto">${ico("zaino", 64, 1.2)}<b>Nessuno zaino</b>
        <span>Crea il tuo primo zaino, poi aggiungi le tasche.</span>
        <button class="btn" data-azione="nuovo" data-tipo="zaino">Crea zaino</button></div>`
  };
}

const tascaScelta = new Map(); // zainoId → tascaId selezionata nei filtri

function vistaZaino(id) {
  const zaino = trovaZaino(id);
  if (!zaino) return nonTrovato();
  const tasche = tascheDi(id).sort(perNome);
  const contenuto = oggettiInZaino(id).sort(perNome);
  let scelta = tascaScelta.get(id);
  if (scelta && !trovaTasca(scelta)) scelta = null;
  const visibili = scelta ? contenuto.filter(o => o.tascaId === scelta) : contenuto;
  const piena = tasche.reduce((m, t) => (!m || oggettiIn(t.id).length > oggettiIn(m.id).length ? t : m), null);

  // Con poche tasche: mappa interattiva. Con tante: pillole scorrevoli.
  const selettore = tasche.length <= 10 ? mappaZaino(zaino, tasche, contenuto, scelta) : `
      <div class="hero2 tinta bagliore" style="${tinta(id)}">${fotoAnimata(id, "zaino", 110)}</div>
      <h2>Tasche</h2>
      <div class="chips">
        ${chipTasca(id, null, "Tutte", contenuto.length, 0, scelta)}
        ${tasche.map((t, i) => chipTasca(id, t.id, t.nome, oggettiIn(t.id).length, i + 1, scelta)).join("")}
        <button class="chip aggiungi" data-azione="nuovo" data-tipo="tasca" data-zaino="${id}">${ico("piu", 18, 2.2)} Tasca</button>
      </div>`;

  return {
    titolo: zaino.nome,
    indietro: { href: "#/", testo: "Zaini" },
    destra: pulsanteModifica("zaino", id),
    html: `
      ${selettore}
      <div class="stats">
        <div class="stat" style="--i:1"><b>${contenuto.length}</b><span>${contenuto.length === 1 ? "oggetto" : "oggetti"}</span></div>
        <div class="stat" style="--i:2"><b>${tasche.length}</b><span>${tasche.length === 1 ? "tasca" : "tasche"}</span></div>
        <div class="stat" style="--i:3"><b class="piccolo">${piena && oggettiIn(piena.id).length ? esc(piena.nome) : "—"}</b><span>la più piena</span></div>
      </div>
      ${scelta ? `
      <a class="barra-tasca" href="#/tasca/${scelta}">
        ${ico("tasca", 22, 1.8)}<span><span>Apri <b>${esc(trovaTasca(scelta).nome)}</b></span><small>Metti oggetti, tag NFC, modifica</small></span>
        ${ico("avanti", 18, 2.2)}</a>` : ""}
      <h2>${scelta ? esc(trovaTasca(scelta).nome) : "Tutto il contenuto"}</h2>
      ${visibili.length
        ? `<div class="griglia-ogg">${visibili.map((o, i) => cardOggetto(o, i, nomeTascaBreve(o))).join("")}</div>
           <p class="nota centro">Tieni premuto un oggetto per spostarlo · scorrilo di lato per toglierlo</p>`
        : `<div class="vuoto piccolo">${ico("scatola", 48, 1.2)}<span>${scelta ? "Questa tasca è vuota." : "Lo zaino è vuoto."}</span>
            ${scelta ? `<button class="btn" data-azione="metti-qui" data-id="${scelta}">Metti oggetti</button>` : ""}</div>`}`
  };
}

function chipTasca(zainoId, tascaId, nome, n, i, scelta) {
  return `<button class="chip ${scelta === tascaId || (!scelta && !tascaId) ? "attivo" : ""}" style="--i:${i}"
     data-azione="scegli-tasca" data-zaino="${zainoId}" data-tasca="${tascaId || ""}" ${tascaId ? `data-drop="${tascaId}"` : ""}>${esc(nome)}<span class="num">${n}</span></button>`;
}

/* ---------- Mappa dello zaino ----------
   Lo zaino al centro, le tasche come bolle disposte su un'ellisse,
   collegate da linee. Tocca una bolla per vedere il suo contenuto,
   tocca lo zaino per vedere tutto. Le bolle accettano oggetti trascinati. */
function mappaZaino(zaino, tasche, contenuto, scelta) {
  const n = tasche.length;
  const pos = tasche.map((t, i) => {
    const angolo = (-90 + (i * 360) / Math.max(n, 1)) * Math.PI / 180;
    return { x: 50 + 38 * Math.cos(angolo), y: 50 + 36 * Math.sin(angolo) };
  });
  const linee = tasche.map((t, i) =>
    `<line x1="50" y1="50" x2="${pos[i].x.toFixed(1)}" y2="${pos[i].y.toFixed(1)}" class="${scelta === t.id ? "attiva" : ""}" style="--i:${i}"/>`).join("");

  const bolle = tasche.map((t, i) => {
    const dentro = oggettiIn(t.id);
    const anteprime = dentro.slice(0, 3).map((o, k) =>
      `<span class="bolla-mini m${k}">${urlFoto.get(o.id) ? `<img src="${urlFoto.get(o.id)}" alt="">` : ico("scatola", 14, 1.8)}</span>`).join("");
    return `
      <button class="bolla ${dentro.length ? "" : "vuota"} ${scelta === t.id ? "attiva" : ""}"
        style="left:${pos[i].x.toFixed(1)}%;top:${pos[i].y.toFixed(1)}%;--i:${i};--prof:${(0.6 + (i % 3) * 0.3).toFixed(1)}"
        data-azione="scegli-tasca" data-zaino="${zaino.id}" data-tasca="${t.id}" data-drop="${t.id}">
        <span class="bolla-cerchio">${dentro.length ? `<span class="bolla-anteprime n${Math.min(dentro.length, 3)}">${anteprime}</span>` : ico("tasca", 22, 1.6)}
          <span class="bolla-num">${dentro.length}</span></span>
        <span class="bolla-nome">${esc(t.nome)}</span>
      </button>`;
  }).join("");

  return `
    <div class="mappa tinta ${n ? "" : "senza-tasche"}" style="${tinta(zaino.id)}">
      <svg class="mappa-linee" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${linee}</svg>
      <button class="mappa-centro ${scelta ? "" : "attivo"}" data-azione="scegli-tasca" data-zaino="${zaino.id}" data-tasca="" aria-label="Tutto il contenuto">
        ${fotoAnimata(zaino.id, "zaino", 72)}
        <span class="mappa-tot">${contenuto.length}</span>
      </button>
      ${bolle}
      <button class="mappa-piu" data-azione="nuovo" data-tipo="tasca" data-zaino="${zaino.id}" aria-label="Nuova tasca">${ico("piu", 20, 2.2)}</button>
      ${n ? "" : `<p class="mappa-aiuto">Aggiungi le tasche con +</p>`}
    </div>`;
}

function vistaTasca(id) {
  const tasca = trovaTasca(id);
  if (!tasca) return nonTrovato();
  const zaino = trovaZaino(tasca.zainoId);
  const dentro = oggettiIn(id).sort(perNome);
  return {
    titolo: tasca.nome,
    indietro: { href: "#/zaino/" + tasca.zainoId, testo: zaino ? zaino.nome : "Zaino" },
    destra: pulsanteModifica("tasca", id),
    html: `
      <p class="sottotitolo">${esc(zaino ? zaino.nome : "")} · ${plurale(dentro.length, "oggetto", "oggetti")}</p>
      <div class="griglia-ogg">
        ${dentro.map((o, i) => cardOggetto(o, i, "In questa tasca", true)).join("")}
        <button class="card-metti" data-azione="metti-qui" data-id="${id}" style="--i:${dentro.length}">
          ${ico("piu", 34, 1.8)}<span>Metti oggetti</span></button>
      </div>
      ${bloccoTag("t", id)}`
  };
}

let filtroInventario = "tutti";

function vistaInventario() {
  const oggetti = [...dati.oggetti].sort(perNome);
  const nDentro = oggetti.filter(o => o.tascaId).length;
  const seg = (val, testo) =>
    `<button class="${filtroInventario === val ? "attivo" : ""}" data-azione="filtro" data-valore="${val}">${testo}</button>`;
  return {
    titolo: "Inventario",
    destra: pulsantePiu("oggetto"),
    html: oggetti.length ? `
      <label class="cerca">${ico("lente", 18, 2)}<input id="cerca" type="search" placeholder="Cerca" enterkeyhint="search"></label>
      <div class="segmenti">${seg("tutti", "Tutti " + oggetti.length)}${seg("dentro", "Dentro " + nDentro)}${seg("fuori", "Fuori " + (oggetti.length - nDentro))}</div>
      <div class="griglia-ogg" id="griglia-oggetti">${oggetti.map((o, i) => cardOggetto(o, i, nomeTascaBreve(o))).join("")}</div>
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
  griglia.querySelectorAll(".card-ogg").forEach(c => {
    const ok = c.dataset.nome.includes(q) && (filtroInventario === "tutti" || c.dataset.stato === filtroInventario);
    c.hidden = !ok;
    if (ok) visibili++;
  });
  document.getElementById("nessun-risultato").hidden = visibili > 0;
}

function vistaOggetto(id) {
  const oggetto = trovaOggetto(id);
  if (!oggetto) return nonTrovato();
  const tasca = oggetto.tascaId && trovaTasca(oggetto.tascaId);
  const zaino = tasca && trovaZaino(tasca.zainoId);
  return {
    titolo: oggetto.nome,
    indietro: { href: "#/inventario", testo: "Inventario" },
    destra: pulsanteModifica("oggetto", id),
    html: `
      <div class="hero2 tinta bagliore ${tasca ? "" : "fuori"}" style="${tinta(id)}">${fotoAnimata(id, "scatola", 110)}</div>

      <a class="posizione ${tasca ? "dentro" : ""}" ${tasca ? `href="#/tasca/${tasca.id}"` : ""}>
        <span class="posizione-ico">${ico(tasca ? "tasca" : "esci", 26, 1.8)}</span>
        <span class="posizione-testo">
          <small>${tasca ? "Si trova in " + esc(zaino ? zaino.nome : "") : "Non è nello zaino"}</small>
          <b>${tasca ? esc(tasca.nome) : "Fuori"}</b>
        </span>
        ${tasca ? ico("avanti", 18, 2.2) : ""}
      </a>

      <ul class="lista senza-mini" style="margin-top:12px">
        <li class="campo"><label for="sposta">Sposta in</label>
          <select id="sposta" data-azione="sposta-oggetto" data-id="${id}">${opzioniPosizione(oggetto.tascaId)}</select></li>
      </ul>
      ${tasca ? `<div class="spazio"></div><button class="btn tenue" data-azione="togli" data-id="${id}">Togli dallo zaino</button>` : ""}
      ${bloccoTag("o", id)}`
  };
}

function vistaImpostazioni() {
  return {
    titolo: "Impostazioni",
    html: `
      <h2>Effetti</h2>
      <ul class="lista senza-mini">
        <li class="campo"><label for="sw-giro" style="flex:1">Movimento con il giroscopio</label>
          <input type="checkbox" class="switch" id="sw-giro" data-azione="giroscopio" ${impostazioni.giroscopio ? "checked" : ""}></li>
        <li class="campo"><label for="sw-sfondo" style="flex:1">Rimuovi sfondo dalle foto</label>
          <input type="checkbox" class="switch" id="sw-sfondo" data-azione="sfondo" ${impostazioni.rimuoviSfondo ? "checked" : ""}></li>
      </ul>
      <p class="nota">Il giroscopio fa muovere oggetti e luci quando inclini l'iPhone: iOS chiede il permesso la prima volta. La rimozione dello sfondo avviene sul telefono (la prima volta scarica circa 40 MB).</p>

      ${datiLocali ? `
      <h2>Dati della versione precedente</h2>
      <ul class="lista senza-mini">
        <li class="campo"><span style="flex:1">Su questo dispositivo</span><span class="valore">${plurale(datiLocali.zaini.length, "zaino", "zaini")}, ${plurale(datiLocali.oggetti.length, "oggetto", "oggetti")}</span></li>
        <li><button class="riga aggiungi" data-azione="migra">Carica nel cloud</button></li>
      </ul>` : ""}

      <h2>Backup</h2>
      <ul class="lista senza-mini">
        <li><button class="riga aggiungi" data-azione="esporta">Esporta backup</button></li>
        <li><button class="riga aggiungi" data-azione="importa">Importa backup</button></li>
      </ul>
      <input id="file-backup" type="file" accept="application/json,.json" hidden>
      <p class="nota">Un file con tutti i dati e le foto. L'importazione sostituisce i dati attuali. I dati sono già salvati su Firebase e sincronizzati tra i tuoi dispositivi.</p>

      <h2>Account</h2>
      <ul class="lista senza-mini">
        <li class="campo"><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(utente.email || "")}</span></li>
        <li><button class="riga rosso" data-azione="esci">Esci</button></li>
      </ul>`
  };
}

function vistaAccesso() {
  return {
    html: `
      <div class="accesso">
        <img class="logo" src="icona.png" alt="">
        <h1>Zaino</h1>
        <p>Accedi con l'account creato su Firebase.</p>
        <form data-azione="accedi">
          <ul class="lista senza-mini">
            <li class="campo"><input name="email" type="email" autocomplete="username" placeholder="Email" required></li>
            <li class="campo"><input name="password" type="password" autocomplete="current-password" placeholder="Password" required></li>
          </ul>
          <p class="errore" id="errore-accesso"></p>
          <button class="btn" id="btn-accedi">Accedi</button>
        </form>
      </div>`
  };
}

function nonTrovato() {
  return { titolo: "Non trovato", indietro: { href: "#/", testo: "Zaini" },
    html: `<div class="vuoto"><b>Elemento non trovato</b><span>Potrebbe essere stato eliminato.</span></div>` };
}

/* ---------- Disegno della schermata ---------- */
let ultimaVista = "";
let animaProssimo = false; // forza l'animazione di entrata (es. cambio filtro)

function render() {
  const [, sezione = "", id] = (location.hash || "#/").split("/");
  const viste = {
    "": vistaZaini, zaino: vistaZaino, tasca: vistaTasca,
    inventario: vistaInventario, oggetto: vistaOggetto, impostazioni: vistaImpostazioni,
    profilo: vistaProfilo
  };
  // Prima del login o mentre arrivano i dati: schermate speciali
  const speciale = utente === null ? vistaAccesso() :
    (utente === undefined || !caricato) ? { html: `<div class="caricamento">Caricamento…</div>` } : null;
  document.body.classList.toggle("senza-menu", !!speciale);
  if (speciale) {
    document.getElementById("nav-titolo").textContent = "";
    document.getElementById("nav-dx").innerHTML = "";
    document.getElementById("indietro").hidden = true;
    document.getElementById("btn-menu").hidden = true;
    document.getElementById("tabbar").innerHTML = "";
    document.getElementById("tasca-attiva").hidden = true;
    if (!document.getElementById("errore-accesso") || !speciale.html.includes("accesso")) {
      document.getElementById("app").innerHTML = speciale.html;
    }
    ultimaVista = "";
    return;
  }

  const vista = (viste[sezione] || vistaZaini)(id);

  // Barra in alto
  document.getElementById("nav-titolo").textContent = vista.titolo;
  document.getElementById("nav-dx").innerHTML = vista.destra || "";
  const indietro = document.getElementById("indietro");
  indietro.hidden = !vista.indietro;
  document.getElementById("btn-menu").hidden = !!vista.indietro;
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
  const nuovaVista = chiave !== ultimaVista;
  document.getElementById("app").classList.toggle("anima", nuovaVista || animaProssimo);
  animaProssimo = false;
  if (nuovaVista) { window.scrollTo(0, 0); ultimaVista = chiave; }
  else if (document.getElementById("cerca")) document.getElementById("cerca").value = testoRicerca;
  applicaFiltri();
  aggiornaScroll();

  // Barra delle schede: capsula con indicatore che scivola
  const scheda = { "": "zaini", zaino: "zaini", tasca: "zaini", inventario: "inventario", oggetto: "inventario" }[sezione];
  const tabbar = document.getElementById("tabbar");
  if (!tabbar.querySelector(".tab-indicatore")) {
    tabbar.innerHTML = `<span class="tab-indicatore"></span>` +
      [["zaini", "#/", "zaino", "Zaini"], ["inventario", "#/inventario", "scatola", "Oggetti"]]
        .map(([nome, href, icona, testo]) => `<a href="${href}" data-scheda="${nome}">${ico(icona, 22, 2)}<span>${testo}</span></a>`).join("");
  }
  tabbar.style.setProperty("--pos", scheda === "inventario" ? 1 : 0);
  tabbar.classList.toggle("nessuna", !scheda);
  tabbar.querySelectorAll("a").forEach(a => a.classList.toggle("attivo", a.dataset.scheda === scheda));

  impostaTintaSfondo(sezione, id);
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
  if (form.dataset.azione === "salva-profilo") salvaProfilo(form);

  if (form.dataset.azione === "accedi") {
    const errore = document.getElementById("errore-accesso");
    const pulsante = document.getElementById("btn-accedi");
    errore.textContent = "";
    pulsante.disabled = true;
    cloud.accedi(form.email.value.trim(), form.password.value).catch(e => {
      pulsante.disabled = false;
      errore.textContent = {
        "auth/invalid-credential": "Email o password errati.",
        "auth/invalid-email": "Email non valida.",
        "auth/too-many-requests": "Troppi tentativi: riprova tra qualche minuto.",
        "auth/network-request-failed": "Nessuna connessione a internet."
      }[e.code] || "Accesso non riuscito (" + (e.code || e.message) + ").";
    });
    return;
  }

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
      animaProssimo = true;
      break;
    case "scegli-tasca":
      tascaScelta.set(el.dataset.zaino, el.dataset.tasca || null);
      animaProssimo = true;
      break;
    case "copia":
      copia(el.dataset.testo);
      return;
    case "annulla-tasca":
      impostaTascaAttiva(null);
      break;
    case "menu":
      apriMenu();
      return;
    case "modifica-profilo":
      apriModificaProfilo();
      return;
    case "esci":
      chiudiMenu();
      if (await chiediConferma("Uscendo, questo dispositivo non mostrerà più i tuoi dati finché non accedi di nuovo.", "Esci")) {
        location.hash = "#/";
        cloud.esci();
      }
      return;
    case "migra":
      migraDatiLocali();
      return;
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
  if (el.dataset.azione === "giroscopio") {
    if (el.checked) {
      avviaGiroscopio().then(ok => {
        impostazioni.giroscopio = ok;
        salvaImpostazioni();
        if (!ok) { el.checked = false; mostraToast("Permesso per il movimento non concesso"); }
      });
    } else {
      impostazioni.giroscopio = false;
      salvaImpostazioni();
      fermaGiroscopio();
    }
  }
  if (el.dataset.azione === "sfondo") {
    impostazioni.rimuoviSfondo = el.checked;
    salvaImpostazioni();
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
function esportaBackup() {
  const pulisci = lista => lista.map(x => ({ ...x }));
  const contenuto = JSON.stringify({
    versione: 3,
    zaini: pulisci(dati.zaini), tasche: pulisci(dati.tasche), oggetti: pulisci(dati.oggetti),
    foto: Object.fromEntries(urlFoto)
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contenuto], { type: "application/json" }));
  a.download = "zaino-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Prepara le scritture per caricare un insieme di dati (backup o versione precedente)
async function operazioniPerDati(origine, foto) {
  const operazioni = [];
  const id = x => typeof x.id === "string" && x.id;
  origine.zaini.filter(id).forEach(z => operazioni.push(["set", "zaini", { id: z.id, nome: String(z.nome) }]));
  origine.tasche.filter(id).forEach(t => operazioni.push(["set", "tasche", { id: t.id, nome: String(t.nome), zainoId: t.zainoId || null }]));
  origine.oggetti.filter(id).forEach(o => operazioni.push(["set", "oggetti", {
    id: o.id, nome: String(o.nome), tascaId: o.tascaId || null, ultimaTascaId: o.ultimaTascaId || null
  }]));
  for (const [idFoto, valore] of Object.entries(foto)) {
    try {
      const blob = valore instanceof Blob ? valore : await (await fetch(valore)).blob();
      const piccola = await ridimensiona(blob, 400, blob.type === "image/png" ? "image/png" : "image/jpeg");
      operazioni.push(["set", "foto", { id: idFoto, dati: await fotoPerDatabase(piccola) }]);
    } catch (e) { console.warn("Foto saltata", idFoto, e); }
  }
  return operazioni;
}

function importaBackup(file) {
  const lettore = new FileReader();
  lettore.onload = async () => {
    let nuovi;
    try {
      nuovi = JSON.parse(lettore.result);
      if (!Array.isArray(nuovi.zaini) || !Array.isArray(nuovi.tasche) || !Array.isArray(nuovi.oggetti)) throw 0;
    } catch (e) {
      return mostraToast("File di backup non valido");
    }
    if (!(await chiediConferma("Tutti i dati attuali verranno sostituiti da quelli del backup.", "Sostituisci"))) return;
    mostraToast("Importazione in corso…");
    const operazioni = [
      ...dati.zaini.map(x => ["delete", "zaini", x.id]),
      ...dati.tasche.map(x => ["delete", "tasche", x.id]),
      ...dati.oggetti.map(x => ["delete", "oggetti", x.id]),
      ...[...urlFoto.keys()].map(id => ["delete", "foto", id]),
      ["delete", "stato", "tascaAttiva"],
      ...(await operazioniPerDati(nuovi, nuovi.foto || {}))
    ];
    try {
      await inBlocco(operazioni);
      mostraToast("Backup importato ✓");
    } catch (e) { /* l'errore è già mostrato da registra() */ }
  };
  lettore.readAsText(file);
}

/* ---------- Dati della versione precedente (salvati nel browser) ---------- */
const CHIAVE_VECCHIA = "zaino-dati-v1";
let datiLocali = null;

function leggiDatiLocali() {
  try {
    const d = JSON.parse(localStorage.getItem(CHIAVE_VECCHIA));
    if (d && Array.isArray(d.zaini) && (d.zaini.length || (d.oggetti || []).length)) {
      datiLocali = { zaini: d.zaini, tasche: d.tasche || [], oggetti: d.oggetti || [] };
    }
  } catch (e) {}
}

// Le foto della versione precedente stavano in IndexedDB "zaino-foto"
async function leggiFotoLocali() {
  if (indexedDB.databases) {
    const elenco = await indexedDB.databases();
    if (!elenco.some(d => d.name === "zaino-foto")) return {};
  }
  const db = await new Promise((ok, ko) => {
    const r = indexedDB.open("zaino-foto", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("foto");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
  const foto = {};
  await new Promise((ok, ko) => {
    const t = db.transaction("foto", "readonly");
    const c = t.objectStore("foto").openCursor();
    c.onsuccess = () => { if (c.result) { foto[c.result.key] = c.result.value; c.result.continue(); } };
    t.oncomplete = ok;
    t.onerror = () => ko(t.error);
  });
  db.close();
  return foto;
}

async function migraDatiLocali() {
  if (!datiLocali) return;
  mostraToast("Caricamento nel cloud…");
  try {
    const foto = await leggiFotoLocali().catch(() => ({}));
    await inBlocco(await operazioniPerDati(datiLocali, foto));
    localStorage.removeItem(CHIAVE_VECCHIA);
    indexedDB.deleteDatabase("zaino-foto");
    datiLocali = null;
    mostraToast("Dati caricati nel cloud ✓");
    render();
  } catch (e) {
    mostraToast("Caricamento non riuscito: riprova con la connessione attiva");
  }
}

/* ---------- Stato della sincronizzazione ---------- */
let timerSync;
function aggiornaSync() {
  const el = document.getElementById("sync");
  clearTimeout(timerSync);
  if (!utente) { el.hidden = true; return; }
  if (!navigator.onLine) {
    el.textContent = "Offline · le modifiche verranno salvate al ritorno della rete";
    el.hidden = false;
  } else if (scrittureInCorso > 0) {
    // mostrato solo se il salvataggio dura più di un attimo
    timerSync = setTimeout(() => { el.textContent = "Salvataggio…"; el.hidden = false; }, 1200);
  } else {
    el.hidden = true;
  }
}
window.addEventListener("online", aggiornaSync);
window.addEventListener("offline", aggiornaSync);

/* =========================================================
   7. AVVIO
   ========================================================= */

// Ridisegna al massimo una volta per fotogramma (gli aggiornamenti arrivano a raffiche)
let renderPrenotato = false;
function prenotaRender() {
  if (renderPrenotato) return;
  renderPrenotato = true;
  requestAnimationFrame(() => { renderPrenotato = false; render(); });
}

function quandoArrivanoDati(collezione, elementi) {
  if (collezione === "foto") {
    urlFoto.clear();
    elementi.forEach(f => urlFoto.set(f.id, f.dati));
    aggiornaColori();
  } else if (collezione === "stato") {
    const ta = elementi.find(x => x.id === "tascaAttiva");
    dati.tascaAttiva = ta ? { tascaId: ta.tascaId, scade: ta.scade } : null;
    const pr = elementi.find(x => x.id === "profilo");
    dati.profilo = pr ? { nome: pr.nome, emoji: pr.emoji, colore: pr.colore } : null;
  } else {
    dati[collezione] = elementi;
  }
  if (caricato) prenotaRender();
}

function quandoDatiPronti() {
  caricato = true;
  if (tagInAttesa) { const tag = tagInAttesa; tagInAttesa = null; gestisciTag(tag); }
  render();
}

cloud.osservaUtente(u => {
  if (smettiDiAscoltare) { smettiDiAscoltare(); smettiDiAscoltare = null; }
  utente = u || null;
  caricato = false;
  dati = datiVuoti();
  urlFoto.clear();
  if (utente) {
    smettiDiAscoltare = cloud.ascolta(utente.uid, quandoArrivanoDati, quandoDatiPronti, e => {
      console.error(e);
      mostraToast("Errore del database: " + (e.code || e.message));
    });
  }
  aggiornaSync();
  render();
});

// Cambio schermata con transizione animata (se il browser la supporta)
const movimentoRidotto = matchMedia("(prefers-reduced-motion: reduce)");
window.addEventListener("hashchange", () => {
  chiudiSheet();
  chiudiMenu();
  if (document.startViewTransition && !movimentoRidotto.matches && caricato) {
    document.startViewTransition(() => render());
  } else render();
});

/* ---------- Effetto 3D al tocco delle card ----------
   La card si inclina verso il punto toccato e mostra un riflesso. */
document.addEventListener("pointerdown", e => {
  const card = e.target.closest(".card-anim");
  if (!card || e.target.closest(".btn-togli") || movimentoRidotto.matches) return;
  const r = card.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  card.style.setProperty("--ry", ((x - 0.5) * 12).toFixed(1) + "deg");
  card.style.setProperty("--rx", ((0.5 - y) * 12).toFixed(1) + "deg");
  card.style.setProperty("--mx", (x * 100).toFixed(0) + "%");
  card.style.setProperty("--my", (y * 100).toFixed(0) + "%");
  card.classList.add("premuto");
}, { passive: true });
function rilasciaCard() {
  document.querySelectorAll(".card-anim.premuto").forEach(c => {
    c.classList.remove("premuto");
    c.style.removeProperty("--rx");
    c.style.removeProperty("--ry");
  });
}
["pointerup", "pointercancel"].forEach(ev => document.addEventListener(ev, rilasciaCard, { passive: true }));
window.addEventListener("scroll", rilasciaCard, { passive: true });
setInterval(renderBanner, 1000); // aggiorna il conto alla rovescia

leggiDatiLocali();
render();

// Service worker: permette alla web app di aprirsi anche offline
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* =========================================================
   8. EFFETTI
   - Scena animata quando si legge un tag NFC
   - Gesti: tieni premuto e trascina · scorri di lato per togliere
   - Giroscopio: parallasse inclinando l'iPhone
   ========================================================= */

/* ---------- Scena NFC ----------
   tipo: "dentro" (l'oggetto cade nello zaino), "fuori" (esce),
         "tasca" (tasca attivata), "gia" (era già lì) */
let timerScena;

function mostraScena({ tipo, oggetto, tasca, promessa }) {
  if (movimentoRidotto.matches) {
    const testi = {
      dentro: oggetto && tasca ? oggetto.nome + " → " + tasca.nome : "",
      fuori: oggetto ? oggetto.nome + " tolto" : "",
      tasca: tasca ? "Tasca attiva: " + tasca.nome : "",
      gia: oggetto ? oggetto.nome + " è già qui" : ""
    };
    return esito(testi[tipo], promessa);
  }
  chiudiScena(true);
  const zainoId = tasca ? tasca.zainoId : null;
  const etichette = {
    dentro: ["Messo in", tasca && tasca.nome],
    fuori: ["Tolto da", tasca && tasca.nome],
    tasca: ["Tasca attiva", "Ora avvicina gli oggetti"],
    gia: ["È già in", tasca && tasca.nome]
  }[tipo];
  const nome = tipo === "tasca" ? tasca.nome : oggetto.nome;
  const urlZaino = zainoId && urlFoto.get(zainoId);
  const urlOggetto = oggetto && urlFoto.get(oggetto.id);

  const el = document.createElement("div");
  el.id = "scena";
  el.className = "scena tipo-" + tipo;
  el.style.cssText = tinta(oggetto ? oggetto.id : zainoId) || "";
  el.innerHTML = `
    <div class="scena-sfondo tinta" style="${tinta(zainoId)}"></div>
    <div class="scena-palco">
      <div class="scena-onda"></div><div class="scena-onda o2"></div>
      <div class="scena-zaino">${urlZaino ? `<img src="${urlZaino}" alt="">` : ico("zaino", 120, 1.1)}</div>
      ${oggetto ? `<div class="scena-oggetto">${urlOggetto ? `<img src="${urlOggetto}" alt="">` : `<span class="scena-ico">${ico("scatola", 64, 1.4)}</span>`}</div>` : ""}
    </div>
    <div class="scena-testo">
      <small>${esc(tipo === "tasca" ? etichette[0] : etichette[0] + " " + (etichette[1] || ""))}</small>
      <b>${esc(nome)}</b>
      ${tipo === "tasca" ? `<span class="scena-meta">${ico("nfc", 18, 2)} ${esc(etichette[1])}</span>` : ""}
      ${promessa ? `<span class="scena-stato">${navigator.onLine ? "Salvataggio…" : "Offline · verrà salvato"}</span>` : ""}
    </div>
    <p class="scena-chiudi">Tocca per chiudere</p>`;
  el.addEventListener("click", () => chiudiScena());
  document.body.appendChild(el);

  if (promessa) promessa.then(() => {
    const s = el.querySelector(".scena-stato");
    if (s) { s.textContent = "✓ Salvato"; s.classList.add("ok"); }
  }, () => {});
  clearTimeout(timerScena);
  timerScena = setTimeout(chiudiScena, tipo === "tasca" ? 2600 : 3000);
}

function chiudiScena(subito) {
  const el = document.getElementById("scena");
  if (!el) return;
  clearTimeout(timerScena);
  if (subito) return el.remove();
  el.classList.add("esce");
  setTimeout(() => el.remove(), 350);
}

/* ---------- Gesti sulle card degli oggetti ----------
   - Scorri di lato: toglie l'oggetto (o lo rimette nell'ultima tasca)
   - Tieni premuto e trascina: lo sposti su una tasca o su "Fuori" */
const PRESSIONE_LUNGA = 380; // millisecondi
let gesto = null;
let sopprimiClick = false;

document.addEventListener("pointerdown", e => {
  if (gesto || e.button > 0) return;
  const card = e.target.closest(".card-ogg");
  if (!card || e.target.closest(".btn-togli")) return;
  const id = card.getAttribute("href").split("/").pop();
  gesto = { card, id, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, modo: null, pointerId: e.pointerId };
  gesto.timer = setTimeout(() => {
    if (gesto && !gesto.modo) iniziaTrascinamento();
  }, PRESSIONE_LUNGA);
});

document.addEventListener("pointermove", e => {
  if (!gesto || e.pointerId !== gesto.pointerId) return;
  gesto.x = e.clientX; gesto.y = e.clientY;
  const dx = e.clientX - gesto.x0, dy = e.clientY - gesto.y0;

  if (!gesto.modo) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) iniziaScorrimento();
    else if (Math.abs(dy) > 10) return annullaGesto(); // è uno scroll della pagina
    else return;
  }
  if (gesto.modo === "scorri") muoviScorrimento(dx);
  if (gesto.modo === "trascina") muoviTrascinamento(e.clientX, e.clientY);
});

// Durante un gesto blocchiamo lo scroll della pagina (serve su iPhone)
document.addEventListener("touchmove", e => {
  if (gesto && gesto.modo) e.preventDefault();
}, { passive: false });

document.addEventListener("pointerup", e => {
  if (!gesto || e.pointerId !== gesto.pointerId) return;
  if (gesto.modo === "scorri") fineScorrimento();
  else if (gesto.modo === "trascina") fineTrascinamento();
  else annullaGesto();
});
document.addEventListener("pointercancel", () => {
  if (!gesto) return;
  if (gesto.modo === "scorri") { gesto.dx = 0; fineScorrimento(); }
  else if (gesto.modo === "trascina") { gesto.bersaglio = null; fineTrascinamento(); }
  else annullaGesto();
});

// Niente trascinamento "nativo" dei link: interromperebbe i nostri gesti
document.addEventListener("dragstart", e => {
  if (e.target.closest && e.target.closest(".card-anim")) e.preventDefault();
});

// Dopo un gesto il "click" sulla card non deve aprire l'oggetto
document.addEventListener("click", e => {
  if (sopprimiClick) { e.preventDefault(); e.stopPropagation(); sopprimiClick = false; }
}, true);

function annullaGesto() {
  if (gesto) clearTimeout(gesto.timer);
  gesto = null;
}

/* --- Scorrimento laterale --- */
function iniziaScorrimento() {
  clearTimeout(gesto.timer);
  rilasciaCard();
  const o = trovaOggetto(gesto.id);
  const ultima = o && o.ultimaTascaId && trovaTasca(o.ultimaTascaId);
  gesto.modo = "scorri";
  gesto.azione = !o ? null : o.tascaId ? "togli" : ultima ? "rimetti" : null;
  gesto.card.classList.add("scorre");
  const etichetta = document.createElement("span");
  etichetta.className = "swipe-etichetta " + (gesto.azione || "nessuna");
  etichetta.innerHTML = gesto.azione === "togli" ? `${ico("esci", 18, 2.2)} Togli`
    : gesto.azione === "rimetti" ? `${ico("tasca", 18, 2.2)} In ${esc(ultima.nome)}` : "Tieni premuto per spostare";
  gesto.card.appendChild(etichetta);
}

function muoviScorrimento(dx) {
  const larghezza = gesto.card.offsetWidth;
  const efficace = gesto.azione ? dx : dx * 0.25; // senza azione possibile: resistenza
  gesto.dx = efficace;
  const avanzamento = Math.min(1, Math.abs(efficace) / (larghezza * 0.4));
  gesto.card.style.transform = `translateX(${efficace}px) rotate(${efficace / 18}deg)`;
  gesto.card.style.setProperty("--swipe", avanzamento.toFixed(2));
  gesto.card.classList.toggle("pronto", avanzamento >= 1 && !!gesto.azione);
}

function fineScorrimento() {
  const { card, id, azione } = gesto;
  const dx = gesto.dx || 0;
  const conferma = azione && Math.abs(dx) >= card.offsetWidth * 0.4;
  sopprimiClick = true;
  setTimeout(() => (sopprimiClick = false), 400);
  gesto = null;
  card.classList.remove("scorre", "pronto");
  card.style.transition = "transform .35s cubic-bezier(.2,.8,.2,1), opacity .35s";
  if (!conferma) {
    card.style.transform = "";
    card.style.removeProperty("--swipe");
    setTimeout(() => { card.style.transition = ""; card.querySelector(".swipe-etichetta")?.remove(); }, 360);
    return;
  }
  card.style.transform = `translateX(${Math.sign(dx) * 130}%) rotate(${Math.sign(dx) * 12}deg)`;
  card.style.opacity = "0";
  setTimeout(() => {
    const o = trovaOggetto(id);
    if (!o) return render();
    if (azione === "togli") {
      const eraIn = trovaTasca(o.tascaId);
      esito(o.nome + " tolto" + (eraIn ? " da " + eraIn.nome : ""), sposta(o, null));
    } else {
      const ultima = trovaTasca(o.ultimaTascaId);
      esito(o.nome + " → " + ultima.nome, sposta(o, ultima.id));
    }
    animaProssimo = false;
    render();
  }, 300);
}

/* --- Trascinamento --- */
function iniziaTrascinamento() {
  const o = trovaOggetto(gesto.id);
  if (!o) return annullaGesto();
  rilasciaCard();
  gesto.modo = "trascina";
  gesto.card.classList.add("trascinato");

  // Copia volante dell'oggetto che segue il dito
  const url = urlFoto.get(o.id);
  const fantasma = document.createElement("div");
  fantasma.className = "fantasma tinta";
  fantasma.style.cssText = tinta(o.id);
  fantasma.innerHTML = url ? `<img src="${url}" alt="">` : ico("scatola", 48, 1.4);
  document.body.appendChild(fantasma);
  gesto.fantasma = fantasma;

  // Pannello con tutte le tasche (e "Fuori") su cui rilasciare
  const piuZaini = dati.zaini.length > 1;
  const tasche = [...dati.tasche].sort((a, b) =>
    (trovaZaino(a.zainoId)?.nome || "").localeCompare(trovaZaino(b.zainoId)?.nome || "", "it") || perNome(a, b));
  const dock = document.createElement("div");
  dock.className = "dock";
  dock.innerHTML = `
    <p>Rilascia <b>${esc(o.nome)}</b> su una tasca</p>
    <div class="dock-tasche">
      ${tasche.map((t, i) => `<span class="dock-tasca ${t.id === o.tascaId ? "attuale" : ""}" data-drop="${t.id}" style="--i:${i}">
        ${piuZaini ? `<small>${esc(trovaZaino(t.zainoId)?.nome || "")}</small>` : ""}${esc(t.nome)}</span>`).join("")}
      <span class="dock-tasca fuori ${o.tascaId ? "" : "attuale"}" data-drop="fuori" style="--i:${tasche.length}">${ico("esci", 16, 2.2)} Fuori</span>
    </div>`;
  document.body.appendChild(dock);
  gesto.dock = dock;
  document.body.classList.add("trascinando");
  muoviTrascinamento(gesto.x, gesto.y);
}

function muoviTrascinamento(x, y) {
  const f = gesto.fantasma;
  const vx = x - (gesto.ux ?? x);
  gesto.ux = x;
  f.style.transform = `translate(${x - 55}px, ${y - 70}px) rotate(${Math.max(-12, Math.min(12, vx * 0.8))}deg)`;
  const sotto = document.elementFromPoint(x, y);
  const bersaglio = sotto && sotto.closest("[data-drop]");
  if (bersaglio !== gesto.bersaglio) {
    gesto.bersaglio?.classList.remove("bersaglio");
    bersaglio?.classList.add("bersaglio");
    gesto.bersaglio = bersaglio;
  }
}

function fineTrascinamento() {
  const { card, id, fantasma, dock, bersaglio } = gesto;
  gesto = null;
  sopprimiClick = true;
  setTimeout(() => (sopprimiClick = false), 400);
  document.body.classList.remove("trascinando");
  const o = trovaOggetto(id);
  const destinazione = bersaglio ? (bersaglio.dataset.drop === "fuori" ? null : bersaglio.dataset.drop) : undefined;

  const pulisci = () => { fantasma.remove(); dock.remove(); card.classList.remove("trascinato"); };
  if (!o || destinazione === undefined || destinazione === o.tascaId) {
    // Nessun bersaglio: la copia torna al suo posto
    const r = card.getBoundingClientRect();
    fantasma.classList.add("torna");
    fantasma.style.transform = `translate(${r.left + r.width / 2 - 55}px, ${r.top + r.width / 2 - 70}px) scale(.8)`;
    dock.classList.add("esce");
    setTimeout(pulisci, 320);
    return;
  }
  // Rilasciato su una tasca: la copia "entra" nel bersaglio
  const r = bersaglio.getBoundingClientRect();
  bersaglio.classList.add("ricevuto");
  fantasma.classList.add("entra");
  fantasma.style.transform = `translate(${r.left + r.width / 2 - 55}px, ${r.top + r.height / 2 - 70}px) scale(.15)`;
  dock.classList.add("esce");
  setTimeout(() => {
    pulisci();
    const tasca = destinazione && trovaTasca(destinazione);
    esito(tasca ? o.nome + " → " + tasca.nome : o.nome + " tolto", sposta(o, destinazione));
    render();
  }, 380);
}

/* ---------- Giroscopio ----------
   Inclinando l'iPhone foto, bolle e sfondo si spostano a strati
   (parallasse). iOS chiede il permesso la prima volta. */
const giro = { attivo: false, base: null, tx: 0, ty: 0, gx: 0, gy: 0 };

function avviaGiroscopio() {
  const D = window.DeviceOrientationEvent;
  if (!D || movimentoRidotto.matches) return Promise.resolve(false);
  const permesso = typeof D.requestPermission === "function" ? D.requestPermission() : Promise.resolve("granted");
  return permesso.then(r => {
    if (r !== "granted") return false;
    if (!giro.attivo) {
      giro.attivo = true;
      giro.base = null;
      window.addEventListener("deviceorientation", suOrientamento);
      document.documentElement.classList.add("giro");
      requestAnimationFrame(cicloGiro);
    }
    return true;
  }).catch(() => false);
}

function fermaGiroscopio() {
  giro.attivo = false;
  window.removeEventListener("deviceorientation", suOrientamento);
  document.documentElement.classList.remove("giro");
  document.documentElement.style.setProperty("--gx", 0);
  document.documentElement.style.setProperty("--gy", 0);
}

function suOrientamento(e) {
  if (e.beta == null || e.gamma == null) return;
  if (!giro.base) giro.base = { b: e.beta, g: e.gamma };
  // La posizione "neutra" segue lentamente come tieni il telefono
  giro.base.b += (e.beta - giro.base.b) * 0.015;
  giro.base.g += (e.gamma - giro.base.g) * 0.015;
  giro.tx = Math.max(-1, Math.min(1, (e.gamma - giro.base.g) / 18));
  giro.ty = Math.max(-1, Math.min(1, (e.beta - giro.base.b) / 18));
}

function cicloGiro() {
  if (!giro.attivo) return;
  const nx = giro.gx + (giro.tx - giro.gx) * 0.12;
  const ny = giro.gy + (giro.ty - giro.gy) * 0.12;
  if (Math.abs(nx - giro.gx) > 0.002 || Math.abs(ny - giro.gy) > 0.002) {
    giro.gx = nx; giro.gy = ny;
    document.documentElement.style.setProperty("--gx", nx.toFixed(3));
    document.documentElement.style.setProperty("--gy", ny.toFixed(3));
  }
  requestAnimationFrame(cicloGiro);
}

// Se l'effetto era già attivo, iOS richiede comunque un tocco per riattivarlo
if (impostazioni.giroscopio) {
  const riattiva = () => {
    avviaGiroscopio();
    document.removeEventListener("touchend", riattiva);
    document.removeEventListener("click", riattiva);
  };
  document.addEventListener("touchend", riattiva);
  document.addEventListener("click", riattiva);
}

/* ---------- Sfondo animato ----------
   Il colore dello sfondo segue lo zaino (o l'oggetto) in primo piano. */
function impostaTintaSfondo(sezione, id) {
  let rif = null;
  if (sezione === "zaino" || sezione === "oggetto") rif = id;
  else if (sezione === "tasca") rif = trovaTasca(id)?.zainoId;
  else rif = dati.zaini[0]?.id;
  const c = rif && coloreFoto.get(rif);
  const r = document.documentElement.style;
  r.setProperty("--bh", c ? c.h : 215);
  r.setProperty("--bs", c ? Math.max(c.s, 30) : 60);
}

/* =========================================================
   9. PROFILO E MENU
   Il profilo (nome, emoji, colore) è salvato nel database:
     utenti/{uid}/stato/profilo { nome, emoji, colore }
   ========================================================= */

const EMOJI_PROFILO = ["🎒", "🦈", "🚀", "🐙", "🦊", "🐼", "⚡️", "🌵", "🎧", "🛹", "🌈", "👾"];
const COLORI_PROFILO = [80, 150, 190, 220, 265, 300, 340, 20, 45];

function profilo() {
  const p = dati.profilo || {};
  const email = (utente && utente.email) || "";
  const nome = p.nome || email.split("@")[0] || "Tu";
  // colore predefinito ricavato dall'email, così è sempre lo stesso
  const hash = [...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return { nome, emoji: p.emoji || "", colore: p.colore ?? COLORI_PROFILO[hash % COLORI_PROFILO.length], email };
}

function avatarHtml(dim = 56) {
  const p = profilo();
  const iniziali = p.nome.split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase();
  return `<span class="avatar" style="--dim:${dim}px;--avatar-h:${p.colore}">${p.emoji ? p.emoji : `<span class="iniziali">${esc(iniziali)}</span>`}</span>`;
}

function medaglie() {
  const n = dati.oggetti.length;
  const conFoto = dati.oggetti.filter(o => urlFoto.has(o.id)).length;
  const fuori = dati.oggetti.filter(o => !o.tascaId).length;
  return [
    ["🎒", "Primo zaino", "Crea uno zaino", dati.zaini.length >= 1],
    ["🗂️", "Organizzato", "5 tasche o più", dati.tasche.length >= 5],
    ["📦", "Collezionista", "10 oggetti", n >= 10],
    ["📸", "Fotografo", "Tutti con foto", n > 0 && conFoto === n],
    ["🧭", "Tutto a posto", "Niente fuori", n > 0 && fuori === 0],
    ["🌈", "Arcobaleno", "5 colori diversi", new Set([...coloreFoto.values()].map(c => Math.round(c.h / 40))).size >= 5]
  ];
}

function vistaProfilo() {
  const p = profilo();
  const n = dati.oggetti.length;
  const dentro = dati.oggetti.filter(o => o.tascaId).length;
  const percentuale = n ? Math.round((dentro / n) * 100) : 0;
  const conFoto = dati.oggetti.filter(o => urlFoto.has(o.id));
  const lista = medaglie();
  return {
    titolo: "Profilo",
    html: `
      <div class="profilo-testa" style="--avatar-h:${p.colore}">
        ${avatarHtml(112)}
        <div class="profilo-nome">${esc(p.nome)}</div>
        <div class="profilo-email">${esc(p.email)}</div>
        <div class="profilo-modifica"><button class="btn tenue" data-azione="modifica-profilo">Modifica profilo</button></div>
      </div>

      <div class="anello-riga" style="--i:1">
        <div class="anello-valore"><div class="anello" style="--p:${percentuale}"></div><b>${percentuale}%</b></div>
        <div class="anello-testo"><b>${percentuale === 100 && n ? "Tutto al suo posto!" : "Nello zaino"}</b>
          <span>${dentro} su ${plurale(n, "oggetto", "oggetti")} sono in una tasca</span></div>
      </div>

      <div class="stats">
        <div class="stat" style="--i:2"><b>${dati.zaini.length}</b><span>${dati.zaini.length === 1 ? "zaino" : "zaini"}</span></div>
        <div class="stat" style="--i:3"><b>${dati.tasche.length}</b><span>tasche</span></div>
        <div class="stat" style="--i:4"><b>${n}</b><span>oggetti</span></div>
      </div>

      ${conFoto.length ? `
      <h2>La tua collezione</h2>
      <div class="collezione">${conFoto.map((o, i) =>
        `<span class="tinta" style="${tinta(o.id)}--i:${i}"><img src="${urlFoto.get(o.id)}" alt="${esc(o.nome)}"></span>`).join("")}</div>` : ""}

      <h2>Traguardi · ${lista.filter(m => m[3]).length}/${lista.length}</h2>
      <div class="medaglie">${lista.map(([emoji, titolo, descr, ok], i) => `
        <div class="medaglia ${ok ? "ottenuta" : ""}" style="--i:${i + 5}">
          <span class="emoji">${emoji}</span><span><b>${titolo}</b><small>${descr}</small></span></div>`).join("")}</div>`
  };
}

function apriModificaProfilo() {
  const p = profilo();
  apriSheet(`
    <form data-azione="salva-profilo" autocomplete="off">
      <div class="sheet-barra">
        <button type="button" class="btn-nav" data-azione="chiudi-sheet">Annulla</button>
        <b>Profilo</b>
        <button class="btn-nav">Fine</button>
      </div>
      <ul class="lista senza-mini">
        <li class="campo"><input name="nome" value="${esc(p.nome)}" placeholder="Il tuo nome" maxlength="40" enterkeyhint="done"></li>
      </ul>
      <h2>Avatar</h2>
      <div class="scelta-emoji">
        <label><input type="radio" name="emoji" value="" ${p.emoji ? "" : "checked"}><span class="iniziali" style="font:800 18px var(--titoli)">Aa</span></label>
        ${EMOJI_PROFILO.map(e => `<label><input type="radio" name="emoji" value="${e}" ${p.emoji === e ? "checked" : ""}><span>${e}</span></label>`).join("")}
      </div>
      <h2>Colore</h2>
      <div class="scelta-colore">
        ${COLORI_PROFILO.map(c => `<label style="--c:${c}"><input type="radio" name="colore" value="${c}" ${p.colore === c ? "checked" : ""}></label>`).join("")}
      </div>
    </form>`);
}

function salvaProfilo(form) {
  const nuovo = {
    id: "profilo",
    nome: form.nome.value.trim().slice(0, 40),
    emoji: form.emoji.value,
    colore: Number(form.colore.value || profilo().colore)
  };
  dati.profilo = { nome: nuovo.nome, emoji: nuovo.emoji, colore: nuovo.colore };
  salvaDoc("stato", nuovo);
  chiudiSheet();
  render();
}

/* ---------- Menu laterale ---------- */
function apriMenu() {
  if (document.getElementById("menu")) return;
  const p = profilo();
  const [, sezione = ""] = (location.hash || "#/").split("/");
  const voce = (href, icona, testo, attiva, i, conta = "") =>
    `<a class="menu-voce ${attiva ? "attiva" : ""}" href="${href}" style="--i:${i}">${ico(icona, 24, 1.9)}${testo}${conta !== "" ? `<span class="conta">${conta}</span>` : ""}</a>`;
  const el = document.createElement("div");
  el.id = "menu";
  el.className = "menu";
  el.innerHTML = `
    <div class="menu-velo" data-azione-menu="chiudi"></div>
    <nav class="menu-pannello" style="--avatar-h:${p.colore}">
      <a class="menu-profilo" href="#/profilo">${avatarHtml(60)}<span><b>${esc(p.nome)}</b><small>${esc(p.email)}</small></span></a>
      ${voce("#/", "zaino", "Zaini", ["", "zaino", "tasca"].includes(sezione), 0, dati.zaini.length)}
      ${voce("#/inventario", "scatola", "Inventario", ["inventario", "oggetto"].includes(sezione), 1, dati.oggetti.length)}
      ${voce("#/profilo", "utente", "Profilo e traguardi", sezione === "profilo", 2)}
      ${voce("#/impostazioni", "regola", "Impostazioni", sezione === "impostazioni", 3)}
      <div class="menu-piede">
        <button class="menu-voce" data-azione="esci" style="--i:5">${ico("esci", 24, 1.9)}Esci</button>
        <p class="menu-marchio">Zaino · i tuoi oggetti, sempre a portata</p>
      </div>
    </nav>`;
  document.body.appendChild(el);
  el.addEventListener("click", e => {
    if (e.target.closest("[data-azione-menu='chiudi'], a")) chiudiMenu();
  });
}

function chiudiMenu() {
  const el = document.getElementById("menu");
  if (!el || el.classList.contains("chiude")) return;
  el.classList.add("chiude");
  setTimeout(() => el.remove(), 300);
}
