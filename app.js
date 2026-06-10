import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { jsPDF } from "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm";
import { LOCAL_DEMO_PASSWORD, LOCAL_DEMO_USER, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const STORAGE_KEY = "taller-solis-web";
const BIOMETRIC_KEY = "taller-solis-biometric";
const SOUND_KEY = "taller-solis-sound";
const TAX = 0.16;
const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = SUPABASE_READY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const sampleDictation =
  "Cliente Juan Perez, camioneta Nissan NP300 2016, cambio de clutch completo, plato, disco y balero, mano de obra seis mil pesos mas IVA, diagnostico: la camioneta no avanza por falla total del clutch";

let state = loadState();
let draft = parseVoice(sampleDictation);
let listening = false;
let currentUser = null;
let isAuthenticated = false;
let biometricEnabled = false;
let biometricAvailable = false;
let soundEnabled = localStorage.getItem(SOUND_KEY) === "on";
let audioContext = null;
let musicTimer = null;
let welcomeSpoken = false;

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

function biometricSupported() {
  return Boolean(window.PublicKeyCredential && navigator.credentials);
}

async function checkBiometricAvailability() {
  if (!biometricSupported()) return false;
  if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return true;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  bytes.forEach((byte) => {
    text += String.fromCharCode(byte);
  });
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBuffer(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const text = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes.buffer;
}

function randomChallenge() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function playTone(frequency, startAt, duration, gainValue = 0.035, type = "sine") {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(gainValue, startAt + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.04);
}

function startBackgroundMusic() {
  if (!soundEnabled || audioContext) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  audioContext = new AudioCtx();
  const loop = () => {
    if (!audioContext || !soundEnabled) return;
    const now = audioContext.currentTime + 0.05;
    playTone(164.81, now, 1.8, 0.026, "triangle");
    playTone(246.94, now + 0.45, 1.4, 0.018, "sine");
    playTone(329.63, now + 1.15, 1.1, 0.014, "sine");
    playTone(61.74, now + 0.02, 0.18, 0.022, "sawtooth");
    musicTimer = window.setTimeout(loop, 2600);
  };
  loop();
}

function stopBackgroundMusic() {
  soundEnabled = false;
  localStorage.setItem(SOUND_KEY, "off");
  if (musicTimer) window.clearTimeout(musicTimer);
  musicTimer = null;
  if (audioContext) {
    audioContext.close().catch(() => undefined);
    audioContext = null;
  }
  window.speechSynthesis?.cancel();
}

function speak(text) {
  if (!soundEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-MX";
  utterance.rate = 0.94;
  utterance.pitch = 0.92;
  window.speechSynthesis.speak(utterance);
}

function playWelcome(force = false) {
  if (!force && welcomeSpoken) return;
  welcomeSpoken = true;
  speak("Hola Leonardo. Bienvenido a Taller Solis Cotizador. Estoy lista para ayudarte a crear cotizaciones.");
}

function updateSoundButton() {
  const button = document.getElementById("sound-button");
  if (!button) return;
  button.classList.toggle("active", soundEnabled);
  button.textContent = soundEnabled ? "VOZ Y MUSICA ACTIVAS" : "ACTIVAR VOZ Y MUSICA";
}

async function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
  if (soundEnabled) {
    startBackgroundMusic();
    if (audioContext?.state === "suspended") await audioContext.resume();
    playWelcome(true);
  } else {
    stopBackgroundMusic();
  }
  updateSoundButton();
}

async function registerBiometric(userName) {
  if (!biometricSupported()) {
    throw new Error("Este celular o navegador no permite huella/passkey.");
  }

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomChallenge(),
      rp: { name: "Taller Solis Cotizador" },
      user: {
        id: new TextEncoder().encode(userName || "solis"),
        name: userName || "solis",
        displayName: "Taller Solis"
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000,
      attestation: "none"
    }
  });

  localStorage.setItem(BIOMETRIC_KEY, JSON.stringify({ id: bufferToBase64Url(credential.rawId), userName }));
  biometricEnabled = true;
}

async function unlockWithBiometric() {
  if (!biometricSupported()) {
    throw new Error("Este celular o navegador no permite huella/passkey.");
  }

  const saved = JSON.parse(localStorage.getItem(BIOMETRIC_KEY) || "null");
  if (!saved?.id) {
    throw new Error("Primero activa la huella con usuario y contrasena.");
  }

  await navigator.credentials.get({
    publicKey: {
      challenge: randomChallenge(),
      allowCredentials: [{ id: base64UrlToBuffer(saved.id), type: "public-key" }],
      userVerification: "required",
      timeout: 60000
    }
  });

  if (SUPABASE_READY) {
    const { data } = await supabase.auth.getSession();
    currentUser = data.session?.user || null;
    if (currentUser) await loadCloudState();
  }

  return true;
}

async function signIn(user, password) {
  if (!SUPABASE_READY) {
    return user === LOCAL_DEMO_USER && password === LOCAL_DEMO_PASSWORD;
  }

  const email = user.includes("@") ? user : `${user}@tallersolis.local`;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return false;
  }

  currentUser = data.user;
  await loadCloudState();
  return true;
}

async function loadCloudState() {
  if (!SUPABASE_READY || !currentUser) return;
  const { data, error } = await supabase.from("app_data").select("payload").eq("user_id", currentUser.id).maybeSingle();
  if (error) {
    console.warn("No se pudo leer Supabase", error.message);
    return;
  }
  if (data?.payload?.quotes && data?.payload?.clients) {
    state = data.payload;
    saveState();
  } else {
    await syncCloudState();
  }
}

async function syncCloudState() {
  saveState();
  if (!SUPABASE_READY || !currentUser) return;
  const { error } = await supabase
    .from("app_data")
    .upsert({ user_id: currentUser.id, payload: state, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) console.warn("No se pudo sincronizar Supabase", error.message);
}

function normalizeAiDraft(data, originalText) {
  const total = Number(data?.precio_total || data?.total || 0);
  const subtotal = total > 0 ? Math.round((total / (1 + TAX)) * 100) / 100 : 0;
  const conceptDescription = data?.concepto || data?.trabajo || "Servicio mecanico solicitado";
  return {
    clientName: data?.cliente || "",
    clientPhone: "",
    vehicle: data?.vehiculo || "",
    brand: "",
    model: "",
    year: "",
    plates: data?.placas || "",
    diagnosis: data?.diagnostico || originalText,
    technical: data?.redaccion_tecnica || technicalText(data?.diagnostico || originalText),
    work: data?.trabajo || conceptDescription,
    parts: data?.refacciones || "",
    observations: data?.observaciones || "Vigencia de la cotizacion: 7 dias. Sujeto a revision fisica de la unidad.",
    concepts: [
      {
        id: `c-${Date.now()}-ia`,
        description: conceptDescription,
        quantity: 1,
        price: subtotal || Number(data?.subtotal || 0)
      }
    ]
  };
}

async function parseWithAssistant(text) {
  if (!SUPABASE_READY || !supabase) {
    return parseVoice(text);
  }
  try {
    const { data, error } = await supabase.functions.invoke("bright-worker", { body: { text } });
    if (error) throw error;
    return normalizeAiDraft(data, text);
  } catch (error) {
    console.warn("IA no disponible, usando extractor local", error.message);
    return parseVoice(text);
  }
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

function wordsToAmount(text) {
  const lower = plain(text).toLowerCase();
  const values = [
    ["diez mil", 10000],
    ["nueve mil", 9000],
    ["ocho mil", 8000],
    ["siete mil", 7000],
    ["seis mil", 6000],
    ["cinco mil", 5000],
    ["cuatro mil", 4000],
    ["tres mil", 3000],
    ["dos mil", 2000],
    ["mil", 1000],
    ["quinientos", 500],
    ["cuatrocientos", 400],
    ["trescientos", 300],
    ["doscientos", 200],
    ["cien", 100]
  ];
  const found = values.find(([label]) => lower.includes(label));
  return found ? found[1] : 0;
}

function findMoneyNear(text, words) {
  const clean = plain(text);
  const lower = clean.toLowerCase();
  const keyword = words.find((word) => lower.includes(word));
  if (!keyword) return 0;
  const start = Math.max(lower.indexOf(keyword) - 45, 0);
  const end = Math.min(lower.indexOf(keyword) + 120, clean.length);
  const segment = clean.slice(start, end);
  return amountFrom(segment.match(/\$?\s*\d[\d,.\s]*/)?.[0] || "") || wordsToAmount(segment);
}

function cleanPersonName(value) {
  return String(value || "")
    .replace(/\b(ahora|ahorita|tiene|trae|con|y|me|dice|le|su)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function extractClient(clean) {
  const patterns = [
    /cliente\s+(?:que\s+)?(?:se\s+llama|llamado|nombre)?\s*([a-z\s]{3,45}?)(?=\s+(?:tiene|trae|con|vino|llego|me|dice|le|su)\b|[,.;]|$)/i,
    /(?:se llama|a nombre de|nombre de)\s+([a-z\s]{3,45}?)(?=\s+(?:tiene|trae|con|vino|llego|me|dice|le|su)\b|[,.;]|$)/i
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    const name = cleanPersonName(match?.[1]);
    if (name) return titleCase(name);
  }
  return "";
}

function extractVehicle(clean) {
  const brands = "(nissan|ford|chevrolet|chevy|toyota|volkswagen|vw|honda|mazda|kia|hyundai|dodge|aveo|versa|tsuru|sentra|march|np300|jetta|vento|spark|fiesta|focus)";
  const match =
    clean.match(new RegExp(`(?:tiene|trae|con|es|vehiculo|carro|coche|camioneta|unidad)\\s+(?:un|una)?\\s*(${brands}[^,.;]*)`, "i")) ||
    clean.match(new RegExp(`\\b(${brands}\\s+[a-z0-9\\s-]{0,30})`, "i"));
  return titleCase((match?.[1] || "").replace(/\s+/g, " "));
}

function extractWork(clean) {
  const lower = clean.toLowerCase();
  const direct = clean.match(/(?:hay que|ay que|se debe|necesita|ocupa|requiere|toca)\s+([^,.]+)/i)?.[1]?.trim();
  if (direct) return titleCase(direct);
  if (lower.includes("horquilla") || lower.includes("orquilla")) return "Cambio de horquilla lado conductor";
  if (lower.includes("clutch") || lower.includes("embrague")) return "Cambio de clutch completo";
  if (lower.includes("freno") || lower.includes("balata")) return "Servicio de frenos";
  if (lower.includes("afinacion")) return "Afinacion";
  return "Servicio mecanico solicitado";
}

function extractDiagnosis(clean) {
  const direct =
    clean.match(/(?:le encontre|se encontro|tiene|trae|presenta|suena|se escucha|diagnostico)\s+([^,.]+)/i)?.[1]?.trim() ||
    "";
  return direct ? titleCase(direct) : titleCase(clean);
}

function technicalText(text) {
  const base = text.trim() || "se detecta una falla reportada por el cliente";
  return `Se detecta ${base.toLowerCase().replace(/\.$/, "")}. La condicion compromete el funcionamiento correcto de la unidad, por lo que se recomienda realizar la reparacion indicada, sustituir los componentes necesarios y verificar el sistema mediante prueba de funcionamiento posterior.`;
}

function parseVoice(text) {
  const clean = plain(text);
  const lower = clean.toLowerCase();
  const client = extractClient(clean);
  const vehicleText = extractVehicle(clean);
  const plates = clean.match(/(?:placas|placa)\s*:?\s*([a-z0-9-]{5,10})/i)?.[1]?.toUpperCase() || "";
  const diagnosis = extractDiagnosis(clean);
  const labor = findMoneyNear(clean, ["mano de obra", "obra", "labor"]);
  const partsPrice = findMoneyNear(clean, ["refaccion", "refacciones", "partes", "kit", "plato", "disco", "balero"]);
  const totalPrice = findMoneyNear(clean, ["precio total", "total", "todo", "le cuesta", "cuesta", "sale en", "queda en"]);
  const clutch = lower.includes("clutch") || lower.includes("embrague");
  const brakes = lower.includes("freno") || lower.includes("balata");
  const work = extractWork(clean);
  const parts = clutch
    ? ["plato de presion", "disco", "balero"].filter((item) => lower.includes(item.split(" ")[0]) || item === "plato de presion").join(", ")
    : brakes
      ? "Balatas y revision de sistema de frenos"
      : lower.includes("horquilla") || lower.includes("orquilla")
        ? "Horquilla lado conductor"
        : clean.match(/(?:incluye|lleva|ocupa|necesita)\s+([^,.]+)/i)?.[1]?.trim() || "";
  const firstPrice = amountFrom(clean.match(/\$?\s*\d[\d,.\s]*/)?.[0] || "") || wordsToAmount(clean);
  const fallbackTotal = totalPrice || labor || partsPrice || firstPrice;
  const finalPriceAsSubtotal = totalPrice ? Math.round((totalPrice / (1 + TAX)) * 100) / 100 : 0;
  const concepts = totalPrice
    ? [{ id: `c-${Date.now()}-1`, description: parts ? `${work} (${parts})` : work, quantity: 1, price: finalPriceAsSubtotal }]
    : [
        { id: `c-${Date.now()}-1`, description: parts ? `${work} (${parts})` : work, quantity: 1, price: partsPrice || Math.max(fallbackTotal - (labor || 0), 0) },
        { id: `c-${Date.now()}-2`, description: "Mano de obra", quantity: 1, price: labor || (partsPrice ? 0 : fallbackTotal) }
      ].filter((item) => item.price > 0 || item.description !== "Mano de obra");
  return {
    clientName: client,
    clientPhone: "",
    vehicle: vehicleText,
    brand: "",
    model: "",
    year: "",
    plates,
    diagnosis,
    technical: technicalText(diagnosis),
    work,
    parts,
    observations: "Vigencia de la cotizacion: 7 dias. Sujeto a revision fisica de la unidad.",
    concepts
  };
}

function missingData(source = draft) {
  const missing = [];
  if (!source.clientName.trim()) missing.push("nombre del cliente");
  if (!source.vehicle.trim()) missing.push("vehiculo");
  if (!source.diagnosis.trim()) missing.push("diagnostico o problema");
  if (!source.work.trim()) missing.push("trabajo a realizar");
  if (!source.concepts.some((item) => item.price > 0)) missing.push("precio total o importe");
  return missing;
}

function renderAiPanel() {
  const missing = missingData();
  const found = [
    draft.clientName ? `Cliente: ${draft.clientName}` : "",
    draft.vehicle ? `Vehiculo: ${draft.vehicle}` : "",
    draft.work ? `Trabajo: ${draft.work}` : "",
    totals().total ? `Total estimado: ${money(totals().total)}` : ""
  ].filter(Boolean);
  document.getElementById("ai-panel").innerHTML = `
    <strong>Leonardo</strong>
    <p>${found.length ? `Entendi esto: ${found.join(" | ")}.` : "Hola Leonardo, en que te puedo ayudar? Cuentame la situacion como te la diga el cliente y yo acomodo los datos."}</p>
    ${
      missing.length
        ? `<p class="ai-warning">Faltan estos datos para llenar bien la cotizacion: ${missing.join(", ")}.</p>
           <p>Me los puedes dictar en una frase, por ejemplo: "Leonardo, el cliente se llama..., trae un..., hay que cambiar..., precio total...".</p>`
        : `<p class="ai-ok">Ya tengo los datos principales. Revisa importes y puedes generar la cotizacion.</p>`
    }
  `;
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
  if (!isAuthenticated && screen !== "login") {
    document.querySelectorAll(".screen").forEach((item) => item.classList.remove("active"));
    document.querySelector("#screen-login").classList.add("active");
    document.querySelector(".tabbar")?.classList.add("locked");
    document.getElementById("login-message").textContent = "Primero entra con contrasena o huella para usar la app.";
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  document.querySelectorAll(".screen").forEach((item) => item.classList.remove("active"));
  document.querySelector(`#screen-${screen}`).classList.add("active");
  document.querySelectorAll(".tabbar button").forEach((button) => button.classList.toggle("active", button.dataset.go === screen));
  document.querySelector(".tabbar")?.classList.toggle("locked", !isAuthenticated);
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function persistAndRender() {
  syncCloudState();
  render();
}

function bindDraft() {
  const fields = {
    "client-name": "clientName",
    vehicle: "vehicle",
    brand: "brand",
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
          <button class="ghost" data-pdf="${quote.id}">PDF</button>
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
  renderAiPanel();
  renderHistory();
  renderClients();
}

function saveQuote(status) {
  const missing = missingData();
  if (status !== "Borrador" && missing.length) {
    alert(`Leonardo, faltan estos datos antes de generar la cotizacion: ${missing.join(", ")}.`);
    return null;
  }
  const quote = { ...structuredClone(draft), id: `q-${Date.now()}`, folio: nextFolio(), status, date: new Date().toISOString() };
  state.quotes = [quote, ...state.quotes];
  const existing = state.clients.find((client) => client.name.toLowerCase() === quote.clientName.toLowerCase());
  if (existing) {
    existing.vehicles = Array.from(new Set([...existing.vehicles, quote.vehicle].filter(Boolean)));
  } else {
    state.clients.unshift({ id: `cl-${Date.now()}`, name: quote.clientName || "Cliente sin nombre", phone: "", vehicles: [quote.vehicle].filter(Boolean) });
  }
  syncCloudState();
  alert(`Cotizacion ${quote.folio} guardada.`);
  go("history");
  return quote;
}

function shareWhatsApp(id) {
  const quote = state.quotes.find((item) => item.id === id);
  if (!quote) return;
  const text = encodeURIComponent(`Cotizacion ${quote.folio}\nCliente: ${quote.clientName}\nVehiculo: ${quote.vehicle}\nTotal: ${money(totals(quote).total)}\n${quote.technical}`);
  window.open(`https://wa.me/?text=${text}`, "_blank");
}

function fileNameFor(quote) {
  return `cotizacion-${quote.folio || "taller-solis"}.pdf`;
}

async function imageDataUrl(path) {
  try {
    const response = await fetch(path, { cache: "reload" });
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch {
    return "";
  }
}

function splitLines(doc, text, maxWidth) {
  return doc.splitTextToSize(String(text || ""), maxWidth);
}

async function buildPdfDoc(source, folio = nextFolio()) {
  const quote = { ...source, folio, date: source.date || new Date().toISOString() };
  const quoteTotals = totals(quote);
  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 16;
  const cardX = margin;
  const cardY = 16;
  const cardW = pageWidth - margin * 2;
  const cardH = pageHeight - 32;
  let y = cardY + 12;

  doc.setFillColor(8, 8, 8);
  doc.rect(0, 0, pageWidth, pageHeight, "F");
  doc.setFillColor(246, 246, 241);
  doc.roundedRect(cardX, cardY, cardW, cardH, 4, 4, "F");

  const logo = await imageDataUrl("./logo-solis.png");
  if (logo) doc.addImage(logo, "PNG", cardX + 10, y - 2, 45, 25);

  doc.setTextColor(10, 10, 10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("TALLER SOLIS", cardX + 66, y + 6);
  doc.setFontSize(11);
  doc.text("A TUS ORDENES", cardX + 66, y + 14);

  doc.setFontSize(20);
  doc.text("COTIZACION", cardX + cardW - 10, y + 6, { align: "right" });
  doc.setTextColor(170, 170, 170);
  doc.setFontSize(10);
  doc.text(`Folio: ${quote.folio}`, cardX + cardW - 10, y + 16, { align: "right" });
  doc.text(`Fecha: ${new Date(quote.date).toLocaleDateString("es-MX")}`, cardX + cardW - 10, y + 23, { align: "right" });

  y += 38;
  doc.setDrawColor(10, 10, 10);
  doc.setLineWidth(0.8);
  doc.line(cardX + 10, y, cardX + cardW - 10, y);
  y += 11;

  doc.setTextColor(10, 10, 10);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Cliente:", cardX + 10, y);
  doc.setFont("helvetica", "normal");
  doc.text(splitLines(doc, quote.clientName || "Pendiente", cardW - 42), cardX + 30, y);
  y += 8;
  doc.setFont("helvetica", "bold");
  doc.text("Vehiculo:", cardX + 10, y);
  doc.setFont("helvetica", "normal");
  doc.text(splitLines(doc, quote.vehicle || "Pendiente", cardW - 46), cardX + 34, y);
  y += 14;

  doc.setTextColor(10, 10, 10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Concepto", cardX + 12, y);
  doc.text("Importe", cardX + cardW - 12, y, { align: "right" });
  y += 7;
  doc.setDrawColor(200, 200, 195);
  doc.setLineWidth(0.3);
  doc.line(cardX + 10, y, cardX + cardW - 10, y);
  y += 9;

  doc.setTextColor(10, 10, 10);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(12);
  quote.concepts.forEach((item) => {
    const lines = splitLines(doc, item.description, 118);
    doc.text(lines, cardX + 12, y);
    doc.text(money(item.quantity * item.price), cardX + cardW - 12, y, { align: "right" });
    y += Math.max(8, lines.length * 6 + 2);
    doc.setDrawColor(215, 215, 210);
    doc.line(cardX + 10, y - 3, cardX + cardW - 10, y - 3);
  });

  y += 7;
  doc.setTextColor(10, 10, 10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Diagnostico / observaciones", cardX + 10, y);
  y += 8;

  const diagnosisText = quote.technical || quote.diagnosis || "Pendiente";
  const diagnosisLines = splitLines(doc, diagnosisText, cardW - 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(diagnosisLines, cardX + 10, y);
  y += diagnosisLines.length * 6 + 6;

  if (quote.observations) {
    const observationLines = splitLines(doc, quote.observations, cardW - 20);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text(observationLines, cardX + 10, y);
    y += observationLines.length * 5 + 8;
  }

  doc.setTextColor(10, 10, 10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(24);
  doc.text(`TOTAL ${money(quoteTotals.total)}`, cardX + cardW - 12, Math.min(y + 12, cardY + cardH - 16), { align: "right" });

  return doc;
}

async function buildPdfBlob(source, folio = nextFolio()) {
  const doc = await buildPdfDoc(source, folio);
  return doc.output("blob");
}

async function downloadPdf(source = draft, folio = nextFolio()) {
  const doc = await buildPdfDoc(source, folio);
  doc.save(fileNameFor({ folio }));
}

async function sharePdf(source = draft, folio = nextFolio()) {
  const blob = await buildPdfBlob(source, folio);
  const file = new File([blob], fileNameFor({ folio }), { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: `Cotizacion ${folio}`,
      text: `Cotizacion ${folio} - Taller Solis`,
      files: [file]
    });
    return;
  }
  await downloadPdf(source, folio);
  const text = encodeURIComponent(`Cotizacion ${folio} generada. Te comparto el PDF.`);
  window.open(`https://wa.me/?text=${text}`, "_blank");
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function setup() {
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
  updateSoundButton();
  document.getElementById("sound-button")?.addEventListener("click", toggleSound);
  biometricEnabled = Boolean(localStorage.getItem(BIOMETRIC_KEY));
  checkBiometricAvailability().then((available) => {
    biometricAvailable = available;
    const fingerButton = document.getElementById("finger-button");
    if (!available) {
      fingerButton.textContent = "HUELLA NO DISPONIBLE";
      fingerButton.disabled = true;
      document.getElementById("finger-hint").textContent = "Este navegador no permite huella. Abre la app desde Chrome y el icono instalado.";
      return;
    }
    fingerButton.textContent = biometricEnabled ? "ENTRAR CON HUELLA" : "ACTIVAR HUELLA";
    document.getElementById("finger-hint").textContent = biometricEnabled
      ? "Huella activada en este celular."
      : "Primero escribe usuario y contrasena. Luego toca ACTIVAR HUELLA.";
  });
  document.querySelector("[data-manual]").addEventListener("click", () => {
    draft = parseVoice("");
    document.getElementById("dictation").value = "";
    go("quote");
  });
  document.getElementById("login-button").addEventListener("click", async () => {
    const user = document.getElementById("login-user").value.trim().toLowerCase();
    const pass = document.getElementById("login-password").value;
    document.getElementById("login-message").textContent = "Validando acceso...";
    if (await signIn(user, pass)) {
      isAuthenticated = true;
      document.getElementById("login-message").textContent = SUPABASE_READY ? "Datos conectados a Supabase." : "Modo local activo.";
      if (biometricAvailable && !localStorage.getItem(BIOMETRIC_KEY) && confirm("Quieres activar huella en este celular?")) {
        try {
          await registerBiometric(user);
          document.getElementById("finger-button").textContent = "ENTRAR CON HUELLA";
          document.getElementById("finger-hint").textContent = "Huella activada en este celular.";
        } catch (error) {
          document.getElementById("login-message").textContent = "Entraste con contrasena. La huella no se pudo activar en este navegador.";
        }
      }
      go("home");
      playWelcome();
    } else {
      document.getElementById("login-message").textContent = "Usuario o contrasena incorrectos.";
    }
  });
  document.getElementById("finger-button").addEventListener("click", async () => {
    const user = document.getElementById("login-user").value.trim().toLowerCase();
    const pass = document.getElementById("login-password").value;
    try {
      if (!biometricAvailable) {
        document.getElementById("login-message").textContent = "Huella no disponible aqui. Abre desde Chrome o usa contrasena.";
        return;
      }
      document.getElementById("login-message").textContent = "Abriendo huella del celular...";
      if (localStorage.getItem(BIOMETRIC_KEY)) {
        await unlockWithBiometric();
        isAuthenticated = true;
        document.getElementById("login-message").textContent = "Acceso con huella correcto.";
        go("home");
        playWelcome();
        return;
      }

      if (!(await signIn(user, pass))) {
        document.getElementById("login-message").textContent = "Primero escribe usuario y contrasena correctos para activar huella.";
        return;
      }

      await registerBiometric(user);
      isAuthenticated = true;
      document.getElementById("finger-hint").textContent = "Huella activada en este celular.";
      document.getElementById("login-message").textContent = "Huella activada. Entrando...";
      go("home");
      playWelcome();
    } catch (error) {
      document.getElementById("login-message").textContent = error.message || "No se pudo usar la huella.";
    }
  });
  document.getElementById("dictation").value = sampleDictation;
  document.getElementById("parse-button").addEventListener("click", async () => {
    document.getElementById("parse-button").textContent = "LEONARDO ESTA PENSANDO...";
    draft = await parseWithAssistant(document.getElementById("dictation").value);
    document.getElementById("parse-button").textContent = "ORDENAR CON IA";
    render();
    const missing = missingData();
    speak(
      missing.length
        ? `Leonardo, ya acomode lo que entendi. Me faltan estos datos: ${missing.join(", ")}.`
        : "Leonardo, ya acomode la cotizacion. Revisa los datos y puedes generar el PDF."
    );
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
    recognition.onresult = async (event) => {
      document.getElementById("dictation").value = event.results[0][0].transcript;
      draft = await parseWithAssistant(document.getElementById("dictation").value);
      render();
      const missing = missingData();
      speak(
        missing.length
          ? `Leonardo, entendi el caso. Faltan estos datos: ${missing.join(", ")}.`
          : "Leonardo, ya tengo los datos principales de la cotizacion."
      );
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
  document.getElementById("pdf-button").addEventListener("click", async () => {
    const missing = missingData();
    if (missing.length && !confirm(`Leonardo, faltan estos datos: ${missing.join(", ")}. Descargar PDF de todos modos?`)) return;
    const button = document.getElementById("pdf-button");
    const original = button.textContent;
    try {
      button.textContent = "GENERANDO PDF...";
      await downloadPdf(draft, nextFolio());
      alert("PDF generado. Revisa tus descargas o el visor que abrio Chrome.");
    } catch (error) {
      alert(`No se pudo generar el PDF: ${error.message || "intenta actualizar la app"}`);
    } finally {
      button.textContent = original;
    }
  });
  document.getElementById("share-pdf-button").addEventListener("click", async () => {
    const missing = missingData();
    if (missing.length) {
      alert(`Leonardo, faltan estos datos antes de enviar el PDF: ${missing.join(", ")}.`);
      return;
    }
    const button = document.getElementById("share-pdf-button");
    const original = button.textContent;
    try {
      button.textContent = "PREPARANDO PDF...";
      const quote = saveQuote("Enviada");
      if (quote) await sharePdf(quote, quote.folio);
    } catch (error) {
      alert(`No se pudo compartir el PDF: ${error.message || "intenta descargarlo primero"}`);
    } finally {
      button.textContent = original;
    }
  });
  document.getElementById("search").addEventListener("input", renderHistory);
  document.getElementById("history-list").addEventListener("click", async (event) => {
    const id = event.target.dataset.id || event.target.dataset.duplicate || event.target.dataset.pdf || event.target.dataset.whatsapp || event.target.dataset.delete;
    if (event.target.dataset.status) state.quotes = state.quotes.map((quote) => (quote.id === id ? { ...quote, status: event.target.dataset.status } : quote));
    if (event.target.dataset.duplicate) {
      const source = state.quotes.find((quote) => quote.id === id);
      state.quotes.unshift({ ...structuredClone(source), id: `q-${Date.now()}`, folio: nextFolio(), status: "Borrador", date: new Date().toISOString(), deletedAt: undefined });
    }
    if (event.target.dataset.whatsapp) shareWhatsApp(id);
    if (event.target.dataset.pdf) {
      const quote = state.quotes.find((item) => item.id === id);
      if (quote) await sharePdf(quote, quote.folio);
    }
    if (event.target.dataset.delete) state.quotes = state.quotes.map((quote) => (quote.id === id ? { ...quote, deletedAt: quote.deletedAt ? undefined : new Date().toISOString() } : quote));
    persistAndRender();
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
    syncCloudState();
    document.getElementById("new-client").value = "";
    document.getElementById("new-phone").value = "";
    document.getElementById("new-vehicle").value = "";
    renderClients();
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => undefined);
  render();
}

setup();
