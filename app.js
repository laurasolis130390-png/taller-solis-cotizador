const STORAGE_KEY = "taller-solis-web";
const TAX = 0.16;
const sampleDictation =
  "Cliente Juan Perez, camioneta Nissan NP300 2016, cambio de clutch completo, plato, disco y balero, mano de obra seis mil pesos mas IVA, diagnostico: la camioneta no avanza por falla total del clutch";

let state = loadState();
let draft = parseVoice(sampleDictation);
let listening = false;

function starterState() {
  const quote = {
    ...parseVoice(sampleDictation),
    id: "q-demo",
    folio: "TS-2026-0001",
    status: "Enviada",
    date: new Date().toISOString()
  };
  return {
    quotes: [quote],
    clients: [{ id: "cl-demo", name: "Juan Perez", phone: "55 1234 5678", vehicles: ["Nissan NP300 2016"] }]
  };
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || starterState();
  } catch {
    return starterState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function money(value) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(value || 0);
}

function plain(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function amountFrom(text) {
  return Number(String(text || "").replace(/[^0-9.]/g, "")) || 0;
}

function technicalText(text) {
  const base = text.trim() || "se detecta una falla reportada por el cliente";
  return `Se detecta ${base.toLowerCase().replace(/\.$/, "")}. La condicion compromete el funcionamiento correcto de la unidad, por lo que se recomienda realizar la reparacion indicada, sustituir los componentes necesarios y verificar el sistema mediante prueba de funcionamiento posterior.`;
}

function parseVoice(text) {
  const clean = plain(text);
  const lower = clean.toLowerCase();
  const client = clean.match(/cliente\s+([^,]+)/i)?.[1]?.trim() || "";
  const vehicle = clean.match(/(nissan|ford|chevrolet|toyota|volkswagen|honda|mazda|kia|hyundai|dodge)\s+([^,]+)/i);
  const year = clean.match(/\b(19|20)\d{2}\b/)?.[0] || "";
  const diagnosis = clean.match(/diagnostico:?\s*(.+)$/i)?.[1]?.trim() || clean;
  const laborText = clean.match(/(?:mano de obra|obra)\s+([a-z0-9\s]+?)\s+(?:pesos|mas|iva|,|$)/i)?.[1] || "";
  const labor = amountFrom(laborText) || (lower.includes("seis mil") ? 6000 : lower.includes("cuatro mil") ? 4000 : 0);
  const work = lower.includes("clutch") ? "Cambio de clutch completo" : "Servicio mecanico solicitado";
  const parts = lower.includes("plato") || lower.includes("disco") || lower.includes("balero") ? "Plato de presion, disco y balero" : "";
  return {
    clientName: client,
    clientPhone: "",
    vehicle: vehicle?.[0]?.trim() || "",
    brand: vehicle?.[1]?.trim() || "",
    model: (vehicle?.[2] || "").replace(year, "").trim(),
    year,
    plates: "",
    diagnosis,
    technical: technicalText(diagnosis),
    work,
    parts,
    observations: "Vigencia de la cotizacion: 7 dias. Sujeto a revision fisica de la unidad.",
    concepts: [
      { id: `c-${Date.now()}-1`, description: parts ? `${work} (${parts})` : work, quantity: 1, price: Math.max(labor - 2000, 0) },
      { id: `c-${Date.now()}-2`, description: "Mano de obra", quantity: 1, price: Math.min(labor || 2000, 2000) }
    ]
  };
}

function totals(source = draft) {
  const subtotal = source.concepts.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const iva = subtotal * TAX;
  return { subtotal, iva, total: subtotal + iva };
}

function nextFolio() {
  const year = new Date().getFullYear();
  const max = state.quotes.reduce((highest, quote) => {
    const number = Number((quote.folio || "").split("-").pop()) || 0;
    return Math.max(highest, number);
  }, 0);
  return `TS-${year}-${String(max + 1).padStart(4, "0")}`;
}

function go(screen) {
  document.querySelectorAll(".screen").forEach((item) => item.classList.remove("active"));
  document.querySelector(`#screen-${screen}`).classList.add("active");
  document.querySelectorAll(".tabbar button").forEach((button) => button.classList.toggle("active", button.dataset.go === screen));
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindDraft() {
  const fields = {
    "client-name": "clientName",
    "client-phone": "clientPhone",
    vehicle: "vehicle",
    brand: "brand",
    model: "model",
    year: "year",
    plates: "plates",
    diagnosis: "diagnosis",
    work: "work",
    parts: "parts",
    technical: "technical",
    observations: "observations"
  };
  Object.entries(fields).forEach(([id, key]) => {
    const el = document.getElementById(id);
    el.value = draft[key] || "";
    el.oninput = () => {
      draft[key] = el.value;
      renderQuote();
    };
  });
}

function renderHome() {
  const month = new Date().getMonth();
  const year = new Date().getFullYear();
  const monthQuotes = state.quotes.filter((quote) => {
    const date = new Date(quote.date);
    return !quote.deletedAt && date.getMonth() === month && date.getFullYear() === year;
  });
  document.getElementById("metric-count").textContent = monthQuotes.length;
  document.getElementById("metric-total").textContent = money(monthQuotes.reduce((sum, quote) => sum + totals(quote).total, 0));
  document.getElementById("metric-accepted").textContent = monthQuotes.filter((quote) => ["Aceptada", "Pagada"].includes(quote.status)).length;
  document.getElementById("metric-pending").textContent = monthQuotes.filter((quote) => ["Borrador", "Enviada"].includes(quote.status)).length;
}

function renderConcepts() {
  document.getElementById("concept-list").innerHTML = draft.concepts
    .map(
      (concept, index) => `
      <div class="concept">
        <label>Descripcion<input data-concept="${index}" data-field="description" value="${escapeHtml(concept.description)}" /></label>
        <label>Cantidad<input data-concept="${index}" data-field="quantity" inputmode="decimal" value="${concept.quantity}" /></label>
        <label>Precio<input data-concept="${index}" data-field="price" inputmode="decimal" value="${concept.price}" /></label>
      </div>`
    )
    .join("");
}

function renderQuote() {
  const quoteTotals = totals();
  document.getElementById("subtotal").textContent = money(quoteTotals.subtotal);
  document.getElementById("iva").textContent = money(quoteTotals.iva);
  document.getElementById("total").textContent = money(quoteTotals.total);
  document.getElementById("paper-preview").innerHTML = `
    <div class="paper-head">
      <div class="paper-logo">TALLER SOLIS<br><span>A TUS ORDENES</span></div>
      <div><strong>COTIZACION</strong><small>Folio: ${nextFolio()}<br>Fecha: ${new Date().toLocaleDateString("es-MX")}</small></div>
    </div>
    <p><b>Cliente:</b> ${escapeHtml(draft.clientName || "Pendiente")}</p>
    <p><b>Vehiculo:</b> ${escapeHtml(draft.vehicle || "Pendiente")}</p>
    <table>
      <thead><tr><th>Concepto</th><th>Importe</th></tr></thead>
      <tbody>${draft.concepts
        .map((item) => `<tr><td>${escapeHtml(item.description)}</td><td>${money(item.quantity * item.price)}</td></tr>`)
        .join("")}</tbody>
    </table>
    <p><b>Diagnostico / observaciones</b><br>${escapeHtml(draft.technical)}</p>
    <div class="paper-total">TOTAL ${money(quoteTotals.total)}</div>
  `;
}

function renderHistory() {
  const query = plain(document.getElementById("search").value).toLowerCase();
  const list = state.quotes.filter((quote) => plain(`${quote.folio} ${quote.clientName} ${quote.vehicle} ${quote.status}`).toLowerCase().includes(query));
  document.getElementById("history-list").innerHTML =
    list
      .map(
        (quote) => `
      <article class="panel quote-row ${quote.deletedAt ? "deleted" : ""}">
        <div class="row-between">
          <div><h2>${quote.folio}</h2><p>${escapeHtml(quote.clientName)} - ${escapeHtml(quote.vehicle)}</p></div>
          <strong>${quote.deletedAt ? "Papelera" : quote.status}</strong>
        </div>
        <b class="quote-total">${money(totals(quote).total)}</b>
        <div class="status-row">
          ${["Borrador", "Enviada", "Aceptada", "Rechazada", "Pagada"].map((status) => `<button data-status="${status}" data-id="${quote.id}">${status}</button>`).join("")}
        </div>
        <div class="actions">
          <button class="ghost" data-duplicate="${quote.id}">DUPLICAR</button>
          <button class="success" data-whatsapp="${quote.id}">WHATSAPP</button>
          <button class="danger" data-delete="${quote.id}">${quote.deletedAt ? "RECUPERAR" : "BORRAR"}</button>
        </div>
      </article>`
      )
      .join("") || `<article class="panel"><p>No hay cotizaciones.</p></article>`;
}

function renderClients() {
  document.getElementById("client-list").innerHTML = state.clients
    .map((client) => {
      const count = state.quotes.filter((quote) => quote.clientName.toLowerCase() === client.name.toLowerCase() && !quote.deletedAt).length;
      return `<article class="panel"><h2>${escapeHtml(client.name)}</h2><p>${escapeHtml(client.phone || "Sin telefono")}</p><p>Vehiculos: ${escapeHtml(client.vehicles.join(", ") || "Sin vehiculos")}</p><b>Cotizaciones: ${count}</b></article>`;
    })
    .join("");
}

function render() {
  renderHome();
  bindDraft();
  renderConcepts();
  renderQuote();
  renderHistory();
  renderClients();
}

function saveQuote(status) {
  const quote = { ...structuredClone(draft), id: `q-${Date.now()}`, folio: nextFolio(), status, date: new Date().toISOString() };
  state.quotes = [quote, ...state.quotes];
  const existing = state.clients.find((client) => client.name.toLowerCase() === quote.clientName.toLowerCase());
  if (existing) {
    existing.phone = quote.clientPhone || existing.phone;
    existing.vehicles = Array.from(new Set([...existing.vehicles, quote.vehicle].filter(Boolean)));
  } else {
    state.clients.unshift({ id: `cl-${Date.now()}`, name: quote.clientName || "Cliente sin nombre", phone: quote.clientPhone, vehicles: [quote.vehicle].filter(Boolean) });
  }
  saveState();
  alert(`Cotizacion ${quote.folio} guardada.`);
  go("history");
}

function shareWhatsApp(id) {
  const quote = state.quotes.find((item) => item.id === id);
  if (!quote) return;
  const text = encodeURIComponent(`Cotizacion ${quote.folio}\nCliente: ${quote.clientName}\nVehiculo: ${quote.vehicle}\nTotal: ${money(totals(quote).total)}\n${quote.technical}`);
  window.open(`https://wa.me/?text=${text}`, "_blank");
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function setup() {
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
  document.querySelector("[data-manual]").addEventListener("click", () => {
    draft = parseVoice("");
    document.getElementById("dictation").value = "";
    go("quote");
  });
  document.getElementById("login-button").addEventListener("click", () => {
    const user = document.getElementById("login-user").value.trim().toLowerCase();
    const pass = document.getElementById("login-password").value;
    if (user === "solis" && pass === "cotizador") go("home");
    else document.getElementById("login-message").textContent = "Usuario o contrasena incorrectos.";
  });
  document.getElementById("finger-button").addEventListener("click", () => {
    document.getElementById("login-message").textContent = "En navegador se simula la huella. Usa el boton ENTRAR.";
  });
  document.getElementById("dictation").value = sampleDictation;
  document.getElementById("parse-button").addEventListener("click", () => {
    draft = parseVoice(document.getElementById("dictation").value);
    render();
  });
  document.getElementById("listen-button").addEventListener("click", () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      listening = !listening;
      document.getElementById("mic-status").textContent = listening ? "STOP" : "MIC";
      document.getElementById("listen-label").textContent = listening ? "Escribe el dictado en el cuadro" : "Dictado por voz";
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "es-MX";
    recognition.onresult = (event) => {
      document.getElementById("dictation").value = event.results[0][0].transcript;
      draft = parseVoice(document.getElementById("dictation").value);
      render();
    };
    recognition.start();
  });
  document.getElementById("technical-button").addEventListener("click", () => {
    draft.technical = technicalText(draft.diagnosis);
    render();
  });
  document.getElementById("add-concept").addEventListener("click", () => {
    draft.concepts.push({ id: `c-${Date.now()}`, description: "Nuevo concepto", quantity: 1, price: 0 });
    render();
  });
  document.getElementById("concept-list").addEventListener("input", (event) => {
    const index = Number(event.target.dataset.concept);
    const field = event.target.dataset.field;
    if (!Number.isNaN(index) && field) {
      draft.concepts[index][field] = field === "description" ? event.target.value : amountFrom(event.target.value);
      renderQuote();
    }
  });
  document.getElementById("draft-button").addEventListener("click", () => saveQuote("Borrador"));
  document.getElementById("save-button").addEventListener("click", () => saveQuote("Enviada"));
  document.getElementById("search").addEventListener("input", renderHistory);
  document.getElementById("history-list").addEventListener("click", (event) => {
    const id = event.target.dataset.id || event.target.dataset.duplicate || event.target.dataset.whatsapp || event.target.dataset.delete;
    if (event.target.dataset.status) state.quotes = state.quotes.map((quote) => (quote.id === id ? { ...quote, status: event.target.dataset.status } : quote));
    if (event.target.dataset.duplicate) {
      const source = state.quotes.find((quote) => quote.id === id);
      state.quotes.unshift({ ...structuredClone(source), id: `q-${Date.now()}`, folio: nextFolio(), status: "Borrador", date: new Date().toISOString(), deletedAt: undefined });
    }
    if (event.target.dataset.whatsapp) shareWhatsApp(id);
    if (event.target.dataset.delete) state.quotes = state.quotes.map((quote) => (quote.id === id ? { ...quote, deletedAt: quote.deletedAt ? undefined : new Date().toISOString() } : quote));
    saveState();
    render();
  });
  document.getElementById("client-button").addEventListener("click", () => {
    const name = document.getElementById("new-client").value.trim();
    if (!name) return alert("Escribe el nombre del cliente.");
    state.clients.unshift({
      id: `cl-${Date.now()}`,
      name,
      phone: document.getElementById("new-phone").value,
      vehicles: [document.getElementById("new-vehicle").value].filter(Boolean)
    });
    saveState();
    document.getElementById("new-client").value = "";
    document.getElementById("new-phone").value = "";
    document.getElementById("new-vehicle").value = "";
    renderClients();
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => undefined);
  render();
}

setup();
