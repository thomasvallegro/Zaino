"use strict";

/* =========================================================
   1. DATI
   Tutto l'inventario è un unico oggetto JavaScript, salvato
   in localStorage (l'archivio di Safari) come testo JSON.
   ========================================================= */

const CHIAVE = "zaino-dati-v1";
const DURATA_TASCA_ATTIVA = 2 * 60 * 1000; // 2 minuti, in millisecondi

function datiVuoti() {
  return {
    zaini: [],   // { id, nome }
    tasche: [],  // { id, nome, zainoId }
    oggetti: [], // { id, nome, tascaId, ultimaTascaId }  tascaId = null → "fuori"
    tascaAttiva: null // { id, scade } dopo aver letto il tag di una tasca
  };
}

function carica() {
  try {
    const testo = localStorage.getItem(CHIAVE);
    if (testo) return Object.assign(datiVuoti(), JSON.parse(testo));
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
const trovaZaino  = id => dati.zaini.find(z => z.id === id);
const trovaTasca  = id => dati.tasche.find(t => t.id === id);
const trovaOggetto = id => dati.oggetti.find(o => o.id === id);
const tascheDi   = zainoId => dati.tasche.filter(t => t.zainoId === zainoId);
const oggettiIn  = tascaId => dati.oggetti.filter(o => o.tascaId === tascaId);
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
}

/* =========================================================
   2. TAG NFC
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
      // Opzione B: c'è una tasca selezionata → l'oggetto va lì
      dati.tascaAttiva.scade = Date.now() + DURATA_TASCA_ATTIVA; // rinnova i 2 minuti
      salva();
      if (oggetto.tascaId === attiva.id) return mostraToast(oggetto.nome + " è già in " + attiva.nome);
      sposta(oggetto, attiva.id);
      return mostraToast(oggetto.nome + " → " + nomeTasca(attiva));
    }

    // Opzione A: nessuna tasca selezionata → dentro/fuori
    if (oggetto.tascaId) {
      const eraIn = posizione(oggetto);
      sposta(oggetto, null);
      return mostraToast(oggetto.nome + " tolto (era in " + eraIn + ")");
    }
    const ultima = oggetto.ultimaTascaId && trovaTasca(oggetto.ultimaTascaId);
    if (ultima) {
      sposta(oggetto, ultima.id);
      return mostraToast(oggetto.nome + " → " + nomeTasca(ultima));
    }
    location.hash = "#/oggetto/" + id;
    return mostraToast(oggetto.nome + ": scegli in quale tasca metterlo");
  }

  mostraToast("Tag non riconosciuto");
}

/* =========================================================
   3. SCHERMATE
   Ogni funzione "vista..." restituisce l'HTML della schermata.
   La schermata corrente dipende dalla parte dopo # nell'indirizzo:
     #/             → lista zaini
     #/zaino/ID     → tasche di uno zaino
     #/tasca/ID     → contenuto di una tasca
     #/inventario   → tutti gli oggetti
     #/oggetto/ID   → dettaglio oggetto
     #/impostazioni → backup
   ========================================================= */

// Evita che un nome come "<b>" venga interpretato come HTML
function esc(testo) {
  return String(testo).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const plurale = (n, uno, tanti) => n + " " + (n === 1 ? uno : tanti);

function bloccoTag(tipo, id) {
  const url = indirizzoTag(tipo, id);
  return `
    <h2>Tag NFC</h2>
    <div class="codice">${esc(url)}</div>
    <div class="azioni">
      <button class="secondario" data-azione="copia" data-testo="${esc(url)}">Copia indirizzo</button>
    </div>
    <p class="nota">Scrivi questo indirizzo sul tag con l'app NFC Tools (Scrivi → Aggiungi un record → URL).</p>`;
}

function vistaZaini() {
  const zaini = [...dati.zaini].sort(perNome);
  const righe = zaini.map(z => `
    <li><a class="riga" href="#/zaino/${z.id}">
      <span>${esc(z.nome)}</span>
      <span class="info">${plurale(oggettiInZaino(z.id).length, "oggetto", "oggetti")} ›</span>
    </a></li>`).join("");
  return {
    titolo: "I miei zaini",
    html: `
      <ul class="lista">${righe || `<li class="vuoto">Nessuno zaino. Creane uno qui sotto.</li>`}</ul>
      <form class="aggiungi" data-azione="nuovo-zaino">
        <input name="nome" placeholder="Nome nuovo zaino" required>
        <button>Crea</button>
      </form>`
  };
}

function vistaZaino(id) {
  const zaino = trovaZaino(id);
  if (!zaino) return nonTrovato();
  const tasche = tascheDi(id).sort(perNome);
  const righe = tasche.map(t => `
    <li><a class="riga" href="#/tasca/${t.id}">
      <span>${esc(t.nome)}</span>
      <span class="info">${plurale(oggettiIn(t.id).length, "oggetto", "oggetti")} ›</span>
    </a></li>`).join("");
  return {
    titolo: zaino.nome,
    indietro: "#/",
    html: `
      <h2>Tasche</h2>
      <ul class="lista">${righe || `<li class="vuoto">Nessuna tasca. Aggiungine una qui sotto.</li>`}</ul>
      <form class="aggiungi" data-azione="nuova-tasca" data-id="${id}">
        <input name="nome" placeholder="Nome nuova tasca" required>
        <button>Aggiungi</button>
      </form>
      <div class="azioni">
        <button class="secondario" data-azione="rinomina-zaino" data-id="${id}">Rinomina</button>
        <button class="pericolo" data-azione="elimina-zaino" data-id="${id}">Elimina zaino</button>
      </div>`
  };
}

function vistaTasca(id) {
  const tasca = trovaTasca(id);
  if (!tasca) return nonTrovato();
  const zaino = trovaZaino(tasca.zainoId);
  const dentro = oggettiIn(id).sort(perNome);
  const altri = dati.oggetti.filter(o => o.tascaId !== id).sort(perNome);

  const righe = dentro.map(o => `
    <li>
      <a class="riga" href="#/oggetto/${o.id}"><span>${esc(o.nome)}</span></a>
      <button class="secondario piccolo" data-azione="togli" data-id="${o.id}">Togli</button>
    </li>`).join("");

  const opzioni = altri.map(o =>
    `<option value="${o.id}">${esc(o.nome)} (${esc(posizione(o))})</option>`).join("");

  return {
    titolo: tasca.nome,
    indietro: "#/zaino/" + tasca.zainoId,
    html: `
      <p class="nota">${esc(zaino ? zaino.nome : "")}</p>
      <h2>Contenuto</h2>
      <ul class="lista">${righe || `<li class="vuoto">Tasca vuota.</li>`}</ul>

      <h2>Metti qui un oggetto</h2>
      ${altri.length ? `
      <form class="aggiungi" data-azione="metti-qui" data-id="${id}">
        <select name="oggetto">${opzioni}</select>
        <button>Metti</button>
      </form>` : ""}
      <form class="aggiungi" data-azione="nuovo-oggetto" data-tasca="${id}">
        <input name="nome" placeholder="Oppure crea nuovo oggetto" required>
        <button>Crea</button>
      </form>

      ${bloccoTag("t", id)}

      <div class="azioni">
        <button class="secondario" data-azione="rinomina-tasca" data-id="${id}">Rinomina</button>
        <button class="pericolo" data-azione="elimina-tasca" data-id="${id}">Elimina tasca</button>
      </div>`
  };
}

function vistaInventario() {
  const oggetti = [...dati.oggetti].sort(perNome);
  const righe = oggetti.map(o => `
    <li data-nome="${esc(o.nome.toLowerCase())}"><a class="riga" href="#/oggetto/${o.id}">
      <span>${esc(o.nome)}</span>
      <span class="info ${o.tascaId ? "stato-dentro" : "stato-fuori"}">${esc(posizione(o))} ›</span>
    </a></li>`).join("");
  return {
    titolo: "Inventario",
    html: `
      ${oggetti.length ? `<input id="cerca" type="search" placeholder="Cerca un oggetto…" style="width:100%;margin-bottom:10px">` : ""}
      <ul class="lista" id="lista-oggetti">${righe || `<li class="vuoto">Nessun oggetto. Aggiungine uno qui sotto.</li>`}</ul>
      <form class="aggiungi" data-azione="nuovo-oggetto">
        <input name="nome" placeholder="Nome nuovo oggetto" required>
        <button>Crea</button>
      </form>`
  };
}

function vistaOggetto(id) {
  const oggetto = trovaOggetto(id);
  if (!oggetto) return nonTrovato();

  // Menu a tendina: "Fuori" + tutte le tasche raggruppate per zaino
  const gruppi = [...dati.zaini].sort(perNome).map(z => {
    const opz = tascheDi(z.id).sort(perNome).map(t =>
      `<option value="${t.id}" ${t.id === oggetto.tascaId ? "selected" : ""}>${esc(t.nome)}</option>`).join("");
    return opz ? `<optgroup label="${esc(z.nome)}">${opz}</optgroup>` : "";
  }).join("");

  return {
    titolo: oggetto.nome,
    indietro: "#/inventario",
    html: `
      <h2>Posizione</h2>
      <p class="${oggetto.tascaId ? "stato-dentro" : "stato-fuori"}" style="margin:0 4px 8px">${esc(posizione(oggetto))}</p>
      <select data-azione="sposta-oggetto" data-id="${id}" style="width:100%">
        <option value="" ${oggetto.tascaId ? "" : "selected"}>Fuori dallo zaino</option>
        ${gruppi}
      </select>

      ${bloccoTag("o", id)}

      <div class="azioni">
        <button class="secondario" data-azione="rinomina-oggetto" data-id="${id}">Rinomina</button>
        <button class="pericolo" data-azione="elimina-oggetto" data-id="${id}">Elimina oggetto</button>
      </div>`
  };
}

function vistaImpostazioni() {
  return {
    titolo: "Backup",
    html: `
      <p class="nota">I dati sono salvati solo in Safari su questo iPhone. Safari può cancellarli se non apri l'app per 7 giorni: esporta un backup ogni tanto.</p>
      <div class="azioni">
        <button data-azione="esporta">Esporta backup</button>
        <button class="secondario" data-azione="importa">Importa backup</button>
        <input id="file-backup" type="file" accept="application/json,.json" hidden>
      </div>
      <h2>Riepilogo</h2>
      <ul class="lista">
        <li>${plurale(dati.zaini.length, "zaino", "zaini")}</li>
        <li>${plurale(dati.tasche.length, "tasca", "tasche")}</li>
        <li>${plurale(dati.oggetti.length, "oggetto", "oggetti")}</li>
      </ul>`
  };
}

function nonTrovato() {
  return { titolo: "Non trovato", indietro: "#/", html: `<p class="nota">Questo elemento non esiste più.</p>` };
}

/* ---------- Disegno della schermata ---------- */
function render() {
  const [, sezione = "", id] = (location.hash || "#/").split("/");
  const viste = {
    "": vistaZaini,
    zaino: vistaZaino,
    tasca: vistaTasca,
    inventario: vistaInventario,
    oggetto: vistaOggetto,
    impostazioni: vistaImpostazioni
  };
  const vista = (viste[sezione] || vistaZaini)(id);

  document.getElementById("titolo").textContent = vista.titolo;
  document.title = vista.titolo + " · Zaino";
  const indietro = document.getElementById("indietro");
  indietro.hidden = !vista.indietro;
  if (vista.indietro) indietro.href = vista.indietro;
  document.getElementById("app").innerHTML = vista.html;

  // Voce del menu evidenziata
  const menuAttivo = { "": "zaini", zaino: "zaini", tasca: "zaini",
    inventario: "inventario", oggetto: "inventario", impostazioni: "impostazioni" }[sezione] || "zaini";
  document.querySelectorAll(".menu a").forEach(a =>
    a.classList.toggle("attivo", a.dataset.sezione === menuAttivo));

  renderBanner();
}

function renderBanner() {
  const banner = document.getElementById("tasca-attiva");
  const attiva = tascaAttiva();
  banner.hidden = !attiva;
  if (attiva) {
    const secondi = Math.ceil((dati.tascaAttiva.scade - Date.now()) / 1000);
    banner.innerHTML = `<span>Tasca attiva: <b>${esc(nomeTasca(attiva))}</b> (${secondi}s)</span>
      <button class="piccolo" data-azione="annulla-tasca">Annulla</button>`;
  }
}

let timerToast;
function mostraToast(testo) {
  const toast = document.getElementById("toast");
  toast.textContent = testo;
  toast.hidden = false;
  clearTimeout(timerToast);
  timerToast = setTimeout(() => (toast.hidden = true), 3500);
}

/* =========================================================
   4. AZIONI DELL'UTENTE
   Invece di collegare ogni pulsante, ascoltiamo tutta la pagina
   ("delegazione degli eventi") e leggiamo l'attributo data-azione.
   ========================================================= */

document.addEventListener("submit", e => {
  const form = e.target;
  const azione = form.dataset.azione;
  if (!azione) return;
  e.preventDefault();
  const nome = form.nome ? form.nome.value.trim() : "";

  if (azione === "nuovo-zaino" && nome) {
    location.hash = "#/zaino/" + creaZaino(nome).id;
  }
  if (azione === "nuova-tasca" && nome) {
    creaTasca(form.dataset.id, nome);
  }
  if (azione === "nuovo-oggetto" && nome) {
    creaOggetto(nome, form.dataset.tasca || null);
    mostraToast("Creato: " + nome);
  }
  if (azione === "metti-qui") {
    const oggetto = trovaOggetto(form.oggetto.value);
    if (oggetto) {
      sposta(oggetto, form.dataset.id);
      mostraToast(oggetto.nome + " → " + nomeTasca(trovaTasca(form.dataset.id)));
    }
  }
  render();
});

document.addEventListener("click", e => {
  const el = e.target.closest("button[data-azione]");
  if (!el) return;
  const id = el.dataset.id;

  switch (el.dataset.azione) {
    case "togli": {
      const o = trovaOggetto(id);
      sposta(o, null);
      mostraToast(o.nome + " tolto");
      break;
    }
    case "rinomina-zaino":   rinomina(trovaZaino(id)); break;
    case "rinomina-tasca":   rinomina(trovaTasca(id)); break;
    case "rinomina-oggetto": rinomina(trovaOggetto(id)); break;
    case "elimina-zaino":
      if (confirm("Eliminare lo zaino e le sue tasche? Gli oggetti resteranno nell'inventario, \"fuori\".")) {
        eliminaZaino(id); location.hash = "#/";
      }
      break;
    case "elimina-tasca": {
      const zainoId = trovaTasca(id).zainoId;
      if (confirm("Eliminare la tasca? I suoi oggetti finiranno \"fuori\".")) {
        eliminaTasca(id); location.hash = "#/zaino/" + zainoId;
      }
      break;
    }
    case "elimina-oggetto":
      if (confirm("Eliminare l'oggetto dall'inventario?")) {
        eliminaOggetto(id); location.hash = "#/inventario";
      }
      break;
    case "copia":
      copia(el.dataset.testo);
      break;
    case "annulla-tasca":
      dati.tascaAttiva = null; salva();
      break;
    case "esporta":
      esportaBackup();
      break;
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
  if (el.id === "file-backup" && el.files[0]) importaBackup(el.files[0]);
});

// Ricerca nell'inventario: nasconde le righe che non contengono il testo
document.addEventListener("input", e => {
  if (e.target.id !== "cerca") return;
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("#lista-oggetti li[data-nome]").forEach(li =>
    (li.hidden = !li.dataset.nome.includes(q)));
});

function rinomina(elemento) {
  if (!elemento) return;
  const nome = prompt("Nuovo nome", elemento.nome);
  if (nome && nome.trim()) { elemento.nome = nome.trim(); salva(); }
}

function copia(testo) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(testo).then(
      () => mostraToast("Indirizzo copiato"),
      () => prompt("Copia questo indirizzo:", testo));
  } else {
    prompt("Copia questo indirizzo:", testo);
  }
}

function esportaBackup() {
  const blob = new Blob([JSON.stringify(dati, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "zaino-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importaBackup(file) {
  const lettore = new FileReader();
  lettore.onload = () => {
    try {
      const nuovi = JSON.parse(lettore.result);
      if (!Array.isArray(nuovi.zaini) || !Array.isArray(nuovi.tasche) || !Array.isArray(nuovi.oggetti)) throw 0;
      if (!confirm("Sostituire tutti i dati attuali con quelli del backup?")) return;
      dati = Object.assign(datiVuoti(), nuovi);
      salva();
      mostraToast("Backup importato");
      render();
    } catch (e) {
      mostraToast("File di backup non valido");
    }
  };
  lettore.readAsText(file);
}

/* =========================================================
   5. AVVIO
   ========================================================= */
window.addEventListener("hashchange", render);
// Se la pagina era già aperta in una scheda e torni a vederla, rileggi i dati
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { dati = carica(); render(); }
});
setInterval(renderBanner, 1000); // aggiorna il conto alla rovescia

gestisciTag();
render();
