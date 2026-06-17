import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { jsPDF } from "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm";
import { LOCAL_DEMO_PASSWORD, LOCAL_DEMO_USER, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase-config.js";

const STORAGE_KEY = "taller-solis-web";
const BIOMETRIC_KEY = "taller-solis-biometric";
const SOUND_KEY = "taller-solis-sound";
const APP_VERSION_KEY = "taller-solis-app-version";
const TAX = 0.16;
const AI_USAGE_START = 2;
const QUOTE_STATUSES = ["Pendiente", "Enviada", "Aprobada", "En reparación", "Lista", "Facturada", "Cancelada"];
const SUPABASE_READY = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = SUPABASE_READY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const sampleDictation =
  "Cliente Juan Perez, camioneta Nissan NP300 2016, cambio de clutch completo, plato, disco y balero, mano de obra seis mil pesos mas IVA, diagnostico: la camioneta no avanza por falla total del clutch";

let state = loadState();
let draft = parseVoice("");
let smartDraft = createSmartDraft();
let listening = false;
let currentUser = null;
let isAuthenticated = false;
let biometricEnabled = false;
let biometricAvailable = false;
let soundEnabled = (() => {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
})();
let audioContext = null;
let musicTimer = null;
let welcomeSpoken = false;
let smartCameraStream = null;

function starterState() {
  return {
    quotes: [],
    clients: [],
    aiUsage: { total: AI_USAGE_START, cardReads: AI_USAGE_START, quoteReads: 0, seededFromOpenAiDashboard: true }
  };
}

function loadState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)) || starterState());
  } catch {
    return starterState();
  }
}

function normalizeState(saved) {
  const clean = saved || starterState();
  clean.quotes = (clean.quotes || []).filter((quote) => quote.id !== "q-demo" && !quote.deletedAt);
  clean.clients = (clean.clients || []).filter((client) => client.id !== "cl-demo");
  clean.aiUsage = clean.aiUsage || { total: 0, cardReads: 0, quoteReads: 0 };
  clean.aiUsage.total = Number(clean.aiUsage.total || 0);
  clean.aiUsage.cardReads = Number(clean.aiUsage.cardReads || 0);
  clean.aiUsage.quoteReads = Number(clean.aiUsage.quoteReads || 0);
  if (!clean.aiUsage.seededFromOpenAiDashboard && clean.aiUsage.total < AI_USAGE_START) {
    clean.aiUsage.total = AI_USAGE_START;
    clean.aiUsage.cardReads = Math.max(clean.aiUsage.cardReads, AI_USAGE_START);
    clean.aiUsage.seededFromOpenAiDashboard = true;
  }
  return clean;
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function trackAiUsage(kind) {
  state.aiUsage = state.aiUsage || { total: 0, cardReads: 0, quoteReads: 0 };
  state.aiUsage.total += 1;
  if (kind === "card") state.aiUsage.cardReads += 1;
  if (kind === "quote") state.aiUsage.quoteReads += 1;
  saveState();
  if (currentUser) syncCloudState();
}

async function refreshAppNow() {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((registrations || []).map((registration) => registration.update().catch(() => undefined)));
  } catch {
    // Continue with cache cleanup.
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // Some browsers may block cache access; reload still helps.
  }
  window.location.href = `./?v=${Date.now()}`;
}

async function checkForAppUpdate() {
  const banner = document.getElementById("update-banner");
  const button = document.getElementById("update-button");
  if (!banner || !button) return;
  button.addEventListener("click", refreshAppNow);
  try {
    const response = await fetch(`./version.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const latest = String(data.version || "");
    if (!latest) return;
    const current = localStorage.getItem(APP_VERSION_KEY);
    if (!current) {
      localStorage.setItem(APP_VERSION_KEY, latest);
      return;
    }
    if (current !== latest) {
      banner.classList.add("ready");
      button.onclick = async () => {
        localStorage.setItem(APP_VERSION_KEY, latest);
        await refreshAppNow();
      };
    }
  } catch {
    // Offline or GitHub still publishing; ignore silently.
  }
}

function createSmartDraft() {
  return {
    status: "Borrador",
    cardImage: "",
    vehicle: { plate: "", brand: "", model: "", year: "", vin: "", color: "" },
    client: { name: "", phone: "", email: "", notes: "" },
    diagnosis: "",
    aiMessage: "Esperando diagnostico para sugerir trabajos, refacciones y mano de obra.",
    lines: [],
    taxIncluded: false
  };
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
    playTone(164.81, now, 1.8, 0.045, "triangle");
    playTone(246.94, now + 0.45, 1.4, 0.03, "sine");
    playTone(329.63, now + 1.15, 1.1, 0.024, "sine");
    playTone(61.74, now + 0.02, 0.18, 0.035, "sawtooth");
    musicTimer = window.setTimeout(loop, 2600);
  };
  loop();
}

function stopBackgroundMusic() {
  soundEnabled = false;
  try {
    localStorage.setItem(SOUND_KEY, "off");
  } catch {
    // Some browsers block storage in strict modes; sound can still be toggled for the session.
  }
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
  const voices = window.speechSynthesis.getVoices?.() || [];
  utterance.voice =
    voices.find((voice) => /es[-_](MX|US|ES)/i.test(voice.lang) && /female|mujer|google|paulina|sabina|helena/i.test(voice.name)) ||
    voices.find((voice) => /es[-_]/i.test(voice.lang)) ||
    null;
  utterance.rate = 1;
  utterance.pitch = 1.02;
  window.speechSynthesis.speak(utterance);
}

function playWelcome(force = false) {
  if (!force && welcomeSpoken) return;
  welcomeSpoken = true;
  speak("Hola Leonardo, bienvenido a Taller Solis Cotizador. Cuentame el caso del cliente con tus palabras, y yo acomodo la cotizacion.");
}

function updateSoundButton() {
  const button = document.getElementById("sound-button");
  if (!button) return;
  button.classList.toggle("active", soundEnabled);
  button.textContent = soundEnabled ? "VOZ Y MUSICA ACTIVAS" : "TOCA AQUI: ACTIVAR VOZ Y MUSICA";
}

async function toggleSound() {
  soundEnabled = !soundEnabled;
  try {
    localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
  } catch {
    // Keep the visible state even if the browser refuses local storage.
  }
  updateSoundButton();
  if (soundEnabled) {
    startBackgroundMusic();
    if (audioContext?.state === "suspended") await audioContext.resume();
    const now = audioContext?.currentTime || 0;
    playTone(392, now + 0.02, 0.18, 0.06, "sine");
    playTone(523.25, now + 0.2, 0.22, 0.055, "sine");
    playTone(659.25, now + 0.42, 0.28, 0.05, "triangle");
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
  const localLoginOk = user === LOCAL_DEMO_USER && password === LOCAL_DEMO_PASSWORD;

  if (!SUPABASE_READY) {
    return localLoginOk;
  }

  const email = user.includes("@") ? user : `${user}@tallersolis.local`;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    if (localLoginOk) {
      currentUser = null;
      return true;
    }
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
    state = normalizeState(data.payload);
    saveState();
    await syncCloudState();
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
  const aiTotal = Number(data?.precio_total || data?.total || 0);
  const spokenTotal = moneyFromText(originalText);
  const total = aiTotal >= 1900 && aiTotal <= 2099 && spokenTotal ? spokenTotal : aiTotal || spokenTotal;
  const subtotal = total > 0 ? Math.round((total / (1 + TAX)) * 100) / 100 : 0;
  const fallback = parseVoice(originalText);
  const clientName = cleanPersonName(data?.cliente) || fallback.clientName;
  const vehicle = extractVehicle(data?.vehiculo || "") || fallback.vehicle;
  const work = formatWork(data?.trabajo || data?.concepto || "") || fallback.work;
  const conceptDescription = formatWork(data?.concepto || data?.trabajo || "") || work || "Servicio mecanico solicitado";
  return {
    clientName,
    clientPhone: "",
    vehicle,
    brand: "",
    model: "",
    year: "",
    plates: data?.placas || "",
    diagnosis: data?.diagnostico || originalText,
    technical: data?.redaccion_tecnica || technicalText(data?.diagnostico || originalText),
    work,
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
    trackAiUsage("quote");
    return normalizeAiDraft(data, text);
  } catch (error) {
    console.warn("IA no disponible, usando extractor local", error.message);
    return parseVoice(text);
  }
}

function hasPositiveConcept(source) {
  return Boolean(source?.concepts?.some((item) => Number(item.price) > 0));
}

function mergeDraft(previous, incoming, spokenText = "") {
  const merged = structuredClone(previous);
  const incomingMissing = missingData(incoming);
  const hasUsefulText = (value) => String(value || "").trim() && !/^pendiente$/i.test(String(value || "").trim());
  const text = plain(spokenText).toLowerCase();

  if (hasUsefulText(incoming.clientName)) merged.clientName = incoming.clientName;
  if (hasUsefulText(incoming.vehicle)) merged.vehicle = incoming.vehicle;
  if (hasUsefulText(incoming.brand)) merged.brand = incoming.brand;
  if (hasUsefulText(incoming.plates)) merged.plates = incoming.plates;
  if (hasUsefulText(incoming.work) && incoming.work !== "Servicio mecanico solicitado") merged.work = incoming.work;
  if (hasUsefulText(incoming.parts)) merged.parts = incoming.parts;

  if (hasUsefulText(incoming.diagnosis) && !/^se llama|cliente\s/i.test(incoming.diagnosis)) {
    merged.diagnosis = incoming.diagnosis;
  }

  if (hasUsefulText(incoming.technical) && !/^se detecta se llama|^se detecta cliente/i.test(incoming.technical)) {
    merged.technical = incoming.technical;
  }

  if (hasUsefulText(incoming.observations)) merged.observations = incoming.observations;

  if (hasPositiveConcept(incoming)) {
    merged.concepts = incoming.concepts;
  } else if (hasUsefulText(incoming.work) && merged.concepts?.length) {
    merged.concepts = merged.concepts.map((item, index) => (index === 0 ? { ...item, description: incoming.work } : item));
  }

  if (!hasPositiveConcept(incoming) && /\b(precio|cuesta|total|pesos?|mxn)\b/.test(text)) {
    const amount = moneyFromText(spokenText);
    if (amount) {
      const price = Math.round((amount / (1 + TAX)) * 100) / 100;
      merged.concepts = [{ id: `c-${Date.now()}-merge`, description: merged.work || "Servicio mecanico solicitado", quantity: 1, price }];
    }
  }

  if (!incomingMissing.includes("diagnostico o problema") && hasUsefulText(incoming.diagnosis)) {
    merged.technical = incoming.technical || technicalText(incoming.diagnosis);
  } else if (merged.diagnosis && !merged.technical) {
    merged.technical = technicalText(merged.diagnosis);
  }

  return merged;
}

function smartVehicleText(source = smartDraft) {
  return [source.vehicle.brand, source.vehicle.model, source.vehicle.year, source.vehicle.color].filter(Boolean).join(" ").trim();
}

function vehicleHistoryFor(vehicle = smartDraft.vehicle) {
  const plate = plain(vehicle.plate || "").toLowerCase();
  const vin = plain(vehicle.vin || "").toLowerCase();
  if (!plate && !vin) return [];
  return state.quotes
    .filter((quote) => {
      const haystack = plain(`${quote.plates || ""} ${quote.vehicle || ""} ${quote.observations || ""}`).toLowerCase();
      return (plate && haystack.includes(plate)) || (vin && haystack.includes(vin));
    })
    .filter((quote) => !quote.deletedAt);
}

function smartTotals(source = smartDraft) {
  const raw = source.lines.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.price || 0), 0);
  if (source.taxIncluded) {
    const subtotal = raw / (1 + TAX);
    const iva = raw - subtotal;
    return { subtotal, iva, total: raw };
  }
  const iva = raw * TAX;
  return { subtotal: raw, iva, total: raw + iva };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.readAsDataURL(file);
  });
}

async function dataUrlFromFile(file) {
  const original = await readFileAsDataUrl(file);
  try {
    const image = new Image();
    image.src = original;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    const maxSide = 1400;
    const ratio = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return original;
  }
}

function normalizeVehicleCard(data = {}) {
  return {
    plate: String(data.placa || data.plate || "").toUpperCase(),
    brand: titleCase(data.marca || data.brand || ""),
    model: titleCase(data.modelo || data.linea || data.model || data.line || ""),
    year: String(data.anio || data.año || data.year || "").replace(/\D/g, "").slice(0, 4),
    vin: String(data.serie || data.vin || data.numero_serie || "").toUpperCase(),
    color: titleCase(data.color || ""),
    state: titleCase(data.entidad || data.estado || data.state || "")
  };
}

function cleanOcrText(text) {
  return plain(String(text || ""))
    .replace(/[|_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchAfterLabel(text, labels, pattern = "[A-Z0-9 -]{3,35}") {
  for (const label of labels) {
    const regex = new RegExp(`${label}\\s*[:#-]?\\s*(${pattern})`, "i");
    const match = text.match(regex);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function parseVehicleCardText(rawText) {
  const text = cleanOcrText(rawText).toUpperCase();
  const brands = ["NISSAN", "CHEVROLET", "FORD", "TOYOTA", "VOLKSWAGEN", "VW", "HONDA", "MAZDA", "KIA", "HYUNDAI", "DODGE", "RENAULT", "SEAT", "FIAT", "MITSUBISHI"];
  const colors = ["BLANCO", "NEGRO", "GRIS", "PLATA", "ROJO", "AZUL", "VERDE", "AMARILLO", "CAFE", "BEIGE", "DORADO", "NARANJA"];
  const vin =
    matchAfterLabel(text, ["NIV", "VIN", "SERIE", "NUMERO DE SERIE", "NO DE SERIE"], "[A-HJ-NPR-Z0-9]{11,17}") ||
    text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] ||
    "";
  const year =
    matchAfterLabel(text, ["ANO", "ANIO", "AÑO", "MODELO"], "(?:19|20)\\d{2}") ||
    text.match(/\b(?:19|20)\d{2}\b/)?.[0] ||
    "";
  const plate =
    matchAfterLabel(text, ["PLACA", "PLACAS", "NUMERO DE PLACA"], "[A-Z0-9-]{5,10}") ||
    text.match(/\b[A-Z]{2,3}[- ]?\d{2,4}[- ]?[A-Z0-9]{0,3}\b/)?.[0]?.replace(/\s/g, "") ||
    "";
  const brand =
    titleCase(matchAfterLabel(text, ["MARCA"], "[A-Z ]{3,20}") || brands.find((item) => text.includes(item)) || "");
  const model =
    titleCase(matchAfterLabel(text, ["LINEA", "SUBMARCA", "MODELO", "VERSION"], "[A-Z0-9 ]{3,30}").replace(/\b(USO|CLASE|TIPO|COLOR|MARCA)\b.*$/i, ""));
  const color = titleCase(matchAfterLabel(text, ["COLOR"], "[A-Z ]{3,18}") || colors.find((item) => text.includes(item)) || "");

  return normalizeVehicleCard({ placa: plate, marca: brand, modelo: model, anio: year, vin, color });
}

async function analyzeVehicleCardLocal(imageData, onProgress = () => undefined) {
  if (!window.Tesseract?.recognize) {
    return { __error: "El lector OCR gratis no cargo. Revisa internet y vuelve a intentar." };
  }
  try {
    const result = await window.Tesseract.recognize(imageData, "spa+eng", {
      logger: (event) => {
        if (event.status) onProgress(event);
      }
    });
    const vehicle = parseVehicleCardText(result?.data?.text || "");
    return {
      ...vehicle,
      __rawText: result?.data?.text || ""
    };
  } catch (error) {
    return { __error: error.message || "No se pudo leer la imagen con OCR local." };
  }
}

async function analyzeVehicleCard(imageData) {
  if (!imageData) return { __error: "Falta la imagen de la tarjeta." };
  if (SUPABASE_READY && supabase) {
    try {
      const { data, error } = await supabase.functions.invoke("vehicle-card", { body: { image: imageData } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      trackAiUsage("card");
      return normalizeVehicleCard(data);
    } catch (error) {
      console.warn("IA de tarjeta no disponible, usando lectura local", error.message);
    }
  }
  return analyzeVehicleCardLocal(imageData, (event) => {
    const status = document.getElementById("smart-scan-status");
    if (!status) return;
    const percent = event.progress ? ` ${Math.round(event.progress * 100)}%` : "";
    status.textContent = `Lectura de respaldo: ${event.status}${percent}`;
  });
}

function fallbackSmartLines(text) {
  const parsed = parseVoice(text);
  if (parsed.concepts?.length) {
    return parsed.concepts.map((item) => ({
      id: `sl-${Date.now()}-${Math.random()}`,
      concept: item.description || parsed.work || "Servicio mecanico sugerido",
      type: /mano de obra/i.test(item.description) ? "mano de obra" : "servicio",
      quantity: item.quantity || 1,
      price: item.price || 0
    }));
  }
  return [
    { id: `sl-${Date.now()}-1`, concept: parsed.work || "Revision y diagnostico", type: "servicio", quantity: 1, price: 0 }
  ];
}

async function analyzeSmartDiagnosis(text) {
  const parsed = await parseWithAssistant(text);
  const lines = parsed.concepts?.length
    ? parsed.concepts.map((item) => ({
        id: `sl-${Date.now()}-${Math.random()}`,
        concept: item.description || parsed.work || "Servicio mecanico sugerido",
        type: /mano de obra/i.test(item.description) ? "mano de obra" : "servicio",
        quantity: item.quantity || 1,
        price: item.price || 0
      }))
    : fallbackSmartLines(text);

  return {
    lines,
    aiMessage: missingData(parsed).length
      ? `Sugerencia generada con datos incompletos. Revisa: ${missingData(parsed).join(", ")}.`
      : "Sugerencia lista. Revisa conceptos, cantidades y precios antes de aprobar."
  };
}

function smartToQuoteDraft() {
  const vehicle = smartVehicleText() || "Vehiculo pendiente";
  return {
    clientName: smartDraft.client.name,
    clientPhone: smartDraft.client.phone,
    vehicle,
    brand: smartDraft.vehicle.brand,
    model: smartDraft.vehicle.model,
    year: smartDraft.vehicle.year,
    plates: smartDraft.vehicle.plate,
    diagnosis: smartDraft.diagnosis,
    technical: technicalText(smartDraft.diagnosis),
    work: smartDraft.lines[0]?.concept || "Servicio mecanico sugerido",
    parts: smartDraft.lines.filter((item) => item.type === "refaccion").map((item) => item.concept).join(", "),
    observations: [
      smartDraft.client.notes,
      `Modulo: Cotizacion inteligente. Estado: ${smartDraft.status}. VIN: ${smartDraft.vehicle.vin || "Pendiente"}.`
    ]
      .filter(Boolean)
      .join("\n"),
    concepts: smartDraft.lines.map((item) => ({
      id: item.id,
      description: `${item.concept}${item.type ? ` (${item.type})` : ""}`,
      quantity: Number(item.quantity || 0),
      price: Number(item.price || 0)
    }))
  };
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

function numericCandidates(text) {
  return [...String(text || "").matchAll(/\$?\s*(\d{1,3}(?:[,\s]\d{3})+|\d+(?:\.\d+)?)\s*(?:pesos?|mxn)?/gi)]
    .map((match) => ({
      value: Number(match[1].replace(/[,\s]/g, "")) || 0,
      raw: match[0],
      index: match.index || 0
    }))
    .filter((item) => item.value > 0);
}

function looksLikeVehicleYear(value, text, index) {
  const near = plain(String(text || "").slice(Math.max(0, index - 24), index + 24)).toLowerCase();
  return value >= 1900 && value <= 2099 && /\b(ano|año|modelo|mod|aveo|nissan|ford|chevrolet|toyota|honda|mazda|jetta|versa|tsuru|np300)\b/.test(near);
}

function moneyFromText(text) {
  const candidates = numericCandidates(text);
  const withMoneyWords = candidates.find((item) => /\$|pesos?|mxn/i.test(item.raw) && !looksLikeVehicleYear(item.value, text, item.index));
  if (withMoneyWords) return withMoneyWords.value;
  const valid = candidates.find((item) => !looksLikeVehicleYear(item.value, text, item.index) && !(item.value >= 1900 && item.value <= 2099));
  return valid?.value || 0;
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
  for (const keyword of words) {
    if (!lower.includes(keyword)) continue;
    const start = lower.indexOf(keyword);
    const end = Math.min(start + 140, clean.length);
    const segment = clean.slice(start, end);
    const amount = moneyFromText(segment) || wordsToAmount(segment);
    if (amount) return amount;
  }
  return 0;
}

function cleanPersonName(value) {
  return String(value || "")
    .replace(/\b(ahora|ahorita|tiene|trae|trajo|llevo|llego|vino|con|y|me|dice|le|su|coche|carro|vehiculo|camioneta)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function formatWork(value) {
  return titleCase(
    String(value || "")
      .replace(/\b(y le|le cuesta|cuesta|precio|total|sale en|queda en|por)\b.*$/i, "")
      .replace(/\b\d+[\d,.\s]*(pesos?|mxn)?\b.*$/i, "")
      .trim()
      .replace(/\by$/i, "")
      .trim()
  )
    .replace(/\bY$/g, "")
    .replace(/^Cambiar\b/, "Cambio de")
    .replace(/\bOrquilla\b/g, "Horquilla")
    .replace(/\bDe\b/g, "de")
    .replace(/\bDel\b/g, "del")
    .replace(/\bLa\b/g, "la")
    .replace(/\bEl\b/g, "el");
}

function extractClient(clean) {
  const patterns = [
    /(?:mi\s+)?cliente\s+(?:que\s+)?(?:se\s+llama|llamado|nombre)?\s*([a-z\s]{3,60}?)(?=\s+(?:tiene|trae|trajo|llevo|llego|vino|con|me|dice|le|su|coche|carro|vehiculo|camioneta)\b|[,.;]|$)/i,
    /(?:se llama|a nombre de|nombre de)\s+([a-z\s]{3,60}?)(?=\s+(?:tiene|trae|trajo|llevo|llego|vino|con|me|dice|le|su|coche|carro|vehiculo|camioneta)\b|[,.;]|$)/i
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
  const stopWords =
    /\b(a revision|a revisi[oó]n|revision|revisi[oó]n|para|porque|y le|le detecte|le detect[eé]|detecte|detect[eé]|encontre|encontr[eé]|presenta|tiene ruido|ruido|sonido|hay que|cambiar|cambio|precio|total|cuesta|le cuesta|diagnostico|diagnóstico)\b.*$/i;
  return titleCase(
    (match?.[1] || "")
      .replace(stopWords, "")
      .replace(/\b(cambiar|cambio|hay que|precio|total|cuesta|le cuesta|tiene ruido|ruido|sonido|diagnostico|diagnóstico)\b.*$/i, "")
      .replace(/\s+/g, " ")
  );
}

function extractWork(clean) {
  const lower = clean.toLowerCase();
  const repair = clean.match(/\b(cambio|cambiar|reparacion|reparar)\s+(?:de\s+)?([^,.]+)/i)?.[0]?.trim();
  if (repair) return formatWork(repair);
  const direct =
    clean.match(/(?:hay que|ay que|se debe|necesita|ocupa|requiere|toca|trabajo|servicio)\s+([^,.]+)/i)?.[1]?.trim() ||
    clean.match(/\b(revision|revisar)\s+(?:de\s+)?([^,.]+)/i)?.[0]?.trim();
  if (direct) return formatWork(direct);
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

function cleanTechnicalSubject(text) {
  const raw = plain(text).toLowerCase();
  let clean = raw
    .replace(/\b(mi|un|una)\s+client[ea]\s+[^,.]{0,60}?(?:me\s+)?(?:trajo|trae|llevo|llego|vino)\s+(?:su\s+)?(?:coche|carro|vehiculo|unidad|camioneta)?\s*(?:porque|por que|con|y)?/gi, " ")
    .replace(/\b(?:cliente|clienta)\s+(?:se\s+llama\s+)?[a-z\s]{2,50}?(?=\s+(?:trajo|trae|tiene|con|porque|por que|su|coche|carro|vehiculo|unidad))/gi, " ")
    .replace(/\b(?:me\s+)?(?:trajo|trae|llevo|llego|vino)\s+(?:su\s+)?(?:coche|carro|vehiculo|unidad|camioneta)?\s*(?:porque|por que|con|y)?/gi, " ")
    .replace(/\b(voy a|vamos a|creo que|pienso que|al parecer|ahora|este|pues|eh|este)\b/gi, " ")
    .replace(/\b(revisarla|revisarlo)\b/gi, "revisar")
    .replace(/\s+/g, " ")
    .trim();

  const afterProblem =
    clean.match(/(?:porque|por que|presenta|se escucha|suena|hace ruido|tiene ruido|le suena|le encontre|detecte|se detecta)\s+(.+)/i)?.[1] ||
    clean;

  clean = afterProblem
    .replace(/\b(?:hay que|se debe|se recomienda|voy a)\b.*$/i, "")
    .replace(/\b(?:precio|cuesta|total|pesos?|mxn)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const hasRearTire = /\b(llanta|rueda)\s+trasera\b/.test(clean) || /\btrasera\b/.test(clean);
  const hasBearing = /\b(balero|rodamiento)\b/.test(clean);
  const hasNoise = /\b(suena|ruido|sonido|golpe|rechino|zumbido)\b/.test(clean);

  if (hasRearTire && hasBearing) return "ruido en la zona de la llanta trasera, con posible desgaste de balero";
  if (hasRearTire && hasNoise) return "ruido en la zona de la llanta trasera";
  if (hasBearing) return "posible desgaste de balero";
  if (/\b(horquilla|orquilla)\b/.test(clean)) return "ruido o desgaste en horquilla de suspension";
  if (/\b(clutch|embrague)\b/.test(clean)) return "falla en el sistema de clutch";
  if (/\b(freno|balata)\b/.test(clean)) return "desgaste o falla en el sistema de frenos";

  clean = clean
    .replace(/\b(suena|le suena|hace ruido|tiene ruido)\b/g, "ruido")
    .replace(/\b(orquilla)\b/g, "horquilla")
    .replace(/^[,.;:\s]+|[,.;:\s]+$/g, "");

  return clean || "una falla reportada por el cliente";
}

function technicalText(text) {
  const base = cleanTechnicalSubject(text);
  return `Se reporta ${base}. Se recomienda realizar revision fisica del componente relacionado, confirmar el diagnostico, efectuar la reparacion indicada y verificar el funcionamiento mediante prueba posterior.`;
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
  const firstPrice = moneyFromText(clean) || wordsToAmount(clean);
  const fallbackTotal = totalPrice || labor || partsPrice || firstPrice;
  const finalPriceAsSubtotal = totalPrice ? Math.round((totalPrice / (1 + TAX)) * 100) / 100 : 0;
  const singleDetectedPrice = !totalPrice && !labor && !partsPrice && firstPrice;
  const conceptDescription = work || "Servicio mecanico solicitado";
  const concepts = totalPrice
    ? [{ id: `c-${Date.now()}-1`, description: conceptDescription, quantity: 1, price: finalPriceAsSubtotal }]
    : singleDetectedPrice
      ? [{ id: `c-${Date.now()}-1`, description: conceptDescription, quantity: 1, price: Math.round((firstPrice / (1 + TAX)) * 100) / 100 }]
    : [
        { id: `c-${Date.now()}-1`, description: conceptDescription, quantity: 1, price: partsPrice || Math.max(fallbackTotal - (labor || 0), 0) },
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
           <p>Me puedes contestar solo lo que falta. Por ejemplo: "Se llama Laura" o "El vehiculo es Aveo 2013". No borrare lo anterior.</p>`
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
  const activeDashboard = document.getElementById("dashboard-active");
  if (activeDashboard) activeDashboard.textContent = monthQuotes.filter((quote) => ["Pendiente", "Enviada", "Aprobada", "En reparación"].includes(quote.status)).length;
  const activeDashboardHero = document.getElementById("dashboard-active-hero");
  if (activeDashboardHero) activeDashboardHero.textContent = monthQuotes.filter((quote) => ["Pendiente", "Enviada", "Aprobada", "En reparación"].includes(quote.status)).length;
  const aiBadge = document.getElementById("ai-usage-badge");
  if (aiBadge) aiBadge.textContent = `IA ${state.aiUsage?.total || 0}`;
  document.getElementById("metric-total").textContent = money(monthQuotes.reduce((sum, quote) => sum + totals(quote).total, 0));
  document.getElementById("metric-accepted").textContent = monthQuotes.filter((quote) => ["Aprobada", "Aceptada", "Facturada", "Pagada"].includes(quote.status)).length;
  document.getElementById("metric-pending").textContent = monthQuotes.filter((quote) => ["Pendiente", "Borrador", "Enviada"].includes(quote.status)).length;
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
  const list = state.quotes.filter((quote) => !quote.deletedAt && plain(`${quote.folio} ${quote.clientName} ${quote.vehicle} ${quote.status}`).toLowerCase().includes(query));
  document.getElementById("history-list").innerHTML =
    list
      .map(
        (quote) => `
      <article class="panel quote-row ${quote.deletedAt ? "deleted" : ""}">
        <div class="row-between">
          <div><h2>${quote.folio}</h2><p>${escapeHtml(quote.clientName)} - ${escapeHtml(quote.vehicle)}</p></div>
          <strong class="status-pill ${plain(quote.status).toLowerCase().replace(/\s+/g, "-")}">${quote.deletedAt ? "Papelera" : quote.status}</strong>
        </div>
        <b class="quote-total">${money(totals(quote).total)}</b>
        <div class="status-row">
          ${QUOTE_STATUSES.map((status) => `<button data-status="${status}" data-id="${quote.id}">${status}</button>`).join("")}
        </div>
        <div class="actions">
          <button class="ghost" data-edit="${quote.id}">EDITAR</button>
          <button class="ghost" data-duplicate="${quote.id}">DUPLICAR</button>
          <button class="ghost" data-pdf="${quote.id}">PDF</button>
          <button class="success" data-whatsapp="${quote.id}">WHATSAPP</button>
          <button class="danger" data-delete="${quote.id}">BORRAR</button>
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

function bindSmartDraft() {
  const vehicleFields = {
    "smart-plate": "plate",
    "smart-brand": "brand",
    "smart-model": "model",
    "smart-year": "year",
    "smart-vin": "vin",
    "smart-color": "color"
  };
  Object.entries(vehicleFields).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = smartDraft.vehicle[key] || "";
    el.oninput = () => {
      smartDraft.vehicle[key] = el.value;
      renderVehicleHistory();
    };
  });

  const clientFields = {
    "smart-client": "name",
    "smart-phone": "phone",
    "smart-email": "email",
    "smart-client-notes": "notes"
  };
  Object.entries(clientFields).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = smartDraft.client[key] || "";
    el.oninput = () => {
      smartDraft.client[key] = el.value;
    };
  });

  const diagnosis = document.getElementById("smart-diagnosis");
  if (diagnosis) {
    diagnosis.value = smartDraft.diagnosis || "";
    diagnosis.oninput = () => {
      smartDraft.diagnosis = diagnosis.value;
    };
  }

  const taxIncluded = document.getElementById("smart-tax-included");
  if (taxIncluded) {
    taxIncluded.checked = Boolean(smartDraft.taxIncluded);
    taxIncluded.onchange = () => {
      smartDraft.taxIncluded = taxIncluded.checked;
      renderSmartTotalsOnly();
    };
  }
}

function renderVehicleHistory() {
  const panel = document.getElementById("smart-vehicle-history");
  if (!panel) return;
  const matches = vehicleHistoryFor();
  if (!matches.length) {
    panel.innerHTML = smartDraft.vehicle.plate || smartDraft.vehicle.vin
      ? "<strong>Vehiculo nuevo</strong><p>No encontre servicios previos con esa placa o VIN. Se creara registro al guardar.</p>"
      : "";
    return;
  }
  const total = matches.reduce((sum, quote) => sum + totals(quote).total, 0);
  const last = matches
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  panel.innerHTML = `
    <strong>Historial encontrado</strong>
    <p>Cliente asociado: ${escapeHtml(last.clientName || "Pendiente")}</p>
    <p>Cotizaciones anteriores: ${matches.length}</p>
    <p>Ultimo servicio: ${new Date(last.date).toLocaleDateString("es-MX")}</p>
    <p>Total historico: ${money(total)}</p>
  `;
}

function renderSmartLines() {
  const list = document.getElementById("smart-lines");
  if (!list) return;
  list.innerHTML =
    smartDraft.lines
      .map(
        (line, index) => `
      <div class="smart-line">
        <label>Concepto<input data-smart-line="${index}" data-smart-field="concept" value="${escapeHtml(line.concept)}" /></label>
        <label>Tipo<select data-smart-line="${index}" data-smart-field="type">
          ${["refaccion", "mano de obra", "servicio"].map((type) => `<option value="${type}" ${line.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select></label>
        <label>Cantidad<input data-smart-line="${index}" data-smart-field="quantity" inputmode="decimal" value="${line.quantity}" /></label>
        <label>Precio unitario<input data-smart-line="${index}" data-smart-field="price" inputmode="decimal" value="${line.price}" /></label>
        <div class="wide row-between"><span>Importe</span><strong>${money(Number(line.quantity || 0) * Number(line.price || 0))}</strong></div>
        <button class="danger wide" data-smart-delete="${index}">QUITAR</button>
      </div>`
      )
      .join("") || `<article class="ai-panel"><strong>Sin conceptos</strong><p>Graba o escribe el diagnostico y toca ANALIZAR Y SUGERIR.</p></article>`;
}

function renderSmartTotalsOnly() {
  const smartQuoteTotals = smartTotals();
  document.getElementById("smart-subtotal").textContent = money(smartQuoteTotals.subtotal);
  document.getElementById("smart-iva").textContent = money(smartQuoteTotals.iva);
  document.getElementById("smart-total").textContent = money(smartQuoteTotals.total);
}

function renderSmart() {
  bindSmartDraft();
  renderSmartLines();
  const preview = document.getElementById("smart-card-preview");
  if (preview) {
    preview.src = smartDraft.cardImage || "";
    preview.classList.toggle("ready", Boolean(smartDraft.cardImage));
  }
  const panel = document.getElementById("smart-ai-panel");
  if (panel) {
    panel.innerHTML = `<strong>Asistente IA</strong><p>${escapeHtml(smartDraft.aiMessage)}</p>`;
  }
  document.getElementById("smart-status-label").textContent = smartDraft.status;
  document.querySelectorAll("[data-smart-status]").forEach((button) => button.classList.toggle("active", button.dataset.smartStatus === smartDraft.status));
  renderSmartTotalsOnly();
  renderVehicleHistory();
}

function render() {
  renderHome();
  bindDraft();
  renderConcepts();
  renderQuote();
  renderAiPanel();
  renderSmart();
  renderHistory();
  renderClients();
}

function saveQuote(status) {
  const missing = missingData();
  if (!["Borrador", "Pendiente"].includes(status) && missing.length) {
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

  const diagnosisText = quote.diagnosis ? technicalText(quote.diagnosis) : quote.technical || "Pendiente";
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

async function openSmartCamera() {
  const status = document.getElementById("smart-scan-status");
  const panel = document.getElementById("smart-camera-panel");
  const video = document.getElementById("smart-camera-video");
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "Este navegador no permite camara con marco. Se abrira la camara normal.";
    document.getElementById("smart-card-photo").click();
    return;
  }
  try {
    smartCameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = smartCameraStream;
    panel.classList.add("active");
    status.textContent = "Coloque la tarjeta dentro del recuadro y toque CAPTURAR TARJETA.";
  } catch (error) {
    status.textContent = "No pude abrir la camara con marco. Revisa permisos o usa la camara normal.";
    document.getElementById("smart-card-photo").click();
  }
}

function closeSmartCamera() {
  const panel = document.getElementById("smart-camera-panel");
  const video = document.getElementById("smart-camera-video");
  smartCameraStream?.getTracks().forEach((track) => track.stop());
  smartCameraStream = null;
  if (video) video.srcObject = null;
  panel?.classList.remove("active");
}

async function captureSmartCard() {
  const video = document.getElementById("smart-camera-video");
  const canvas = document.getElementById("smart-camera-canvas");
  const status = document.getElementById("smart-scan-status");
  if (!video?.videoWidth || !video?.videoHeight) {
    status.textContent = "La camara aun no esta lista. Espera un segundo y vuelve a capturar.";
    return;
  }

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const cropWidth = sourceWidth * 0.86;
  const cropHeight = cropWidth / 1.65;
  const cropX = sourceWidth * 0.07;
  const cropY = Math.max(0, sourceHeight * 0.19);
  const safeHeight = Math.min(cropHeight, sourceHeight - cropY);
  canvas.width = 1200;
  canvas.height = Math.round((safeHeight / cropWidth) * canvas.width);
  const context = canvas.getContext("2d");
  context.drawImage(video, cropX, cropY, cropWidth, safeHeight, 0, 0, canvas.width, canvas.height);
  smartDraft.cardImage = canvas.toDataURL("image/jpeg", 0.82);
  smartDraft.aiMessage = "Foto capturada dentro del marco. Toca LEER TARJETA CON IA.";
  status.textContent = "Vista previa lista. Revisa que la tarjeta se vea completa antes de leerla.";
  closeSmartCamera();
  renderSmart();
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function setup() {
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
  document.querySelector("[data-new-voice]")?.addEventListener("click", () => {
    draft = parseVoice("");
    document.getElementById("dictation").value = "";
    go("quote");
  });
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
  document.querySelector("[data-manual]")?.addEventListener("click", () => {
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
      document.getElementById("login-message").textContent = currentUser ? "Datos conectados a Supabase." : "Modo local activo.";
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
    const spokenText = document.getElementById("dictation").value;
    const incoming = await parseWithAssistant(spokenText);
    draft = mergeDraft(draft, incoming, spokenText);
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
      const spokenText = event.results[0][0].transcript;
      const dictation = document.getElementById("dictation");
      dictation.value = dictation.value.trim() ? `${dictation.value.trim()}\n${spokenText}` : spokenText;
      const incoming = await parseWithAssistant(spokenText);
      draft = mergeDraft(draft, incoming, spokenText);
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
  document.getElementById("smart-card-photo").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    smartDraft.cardImage = await dataUrlFromFile(file);
    smartDraft.aiMessage = "Foto cargada. Toca LEER TARJETA CON IA o captura los datos manualmente.";
    renderSmart();
  });
  document.getElementById("smart-open-camera")?.addEventListener("click", openSmartCamera);
  document.getElementById("smart-close-camera")?.addEventListener("click", closeSmartCamera);
  document.getElementById("smart-capture-button")?.addEventListener("click", captureSmartCard);
  document.getElementById("smart-retake-button")?.addEventListener("click", () => {
    openSmartCamera();
  });
  document.getElementById("smart-scan-button").addEventListener("click", async () => {
    const button = document.getElementById("smart-scan-button");
    const status = document.getElementById("smart-scan-status");
    const original = button.textContent;
    if (!smartDraft.cardImage) {
      status.textContent = "Primero toma una foto de la tarjeta.";
      return;
    }
    try {
      button.textContent = "LEYENDO TARJETA...";
      status.textContent = "Leyendo imagen con IA. Revisa y corrige cualquier dato sugerido.";
      const vehicle = await analyzeVehicleCard(smartDraft.cardImage);
      if (vehicle.__error) {
        status.textContent = "No se pudo leer automaticamente. Puedes llenar los datos manualmente.";
        smartDraft.aiMessage = `Lectura no disponible: ${vehicle.__error}`;
        return;
      }
      const cleanVehicle = Object.fromEntries(Object.entries(vehicle).filter(([key, value]) => key !== "__error" && value));
      smartDraft.vehicle = { ...smartDraft.vehicle, ...cleanVehicle };
      status.textContent = Object.values(cleanVehicle).some(Boolean) ? "Lectura terminada. Revisa los datos sugeridos." : "No encontre datos claros. Intenta otra foto mas derecha y con luz.";
      smartDraft.aiMessage = Object.values(cleanVehicle).some(Boolean)
        ? "Datos de vehiculo sugeridos por IA. Revisa placa, VIN, marca, modelo y ano antes de continuar."
        : "No encontre datos claros. Intenta otra foto con buena luz o capturalos manualmente.";
    } finally {
      button.textContent = original;
      renderSmart();
    }
  });
  document.getElementById("smart-record-button").addEventListener("click", () => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      smartDraft.aiMessage = "Este navegador no permite dictado. Escribe el diagnostico manualmente.";
      renderSmart();
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "es-MX";
    recognition.onresult = (event) => {
      const spokenText = event.results[0][0].transcript;
      smartDraft.diagnosis = smartDraft.diagnosis.trim() ? `${smartDraft.diagnosis.trim()}\n${spokenText}` : spokenText;
      smartDraft.aiMessage = "Diagnostico capturado. Revisa el texto y toca ANALIZAR Y SUGERIR.";
      renderSmart();
    };
    recognition.start();
  });
  document.getElementById("smart-analyze-button").addEventListener("click", async () => {
    smartDraft.diagnosis = document.getElementById("smart-diagnosis").value;
    if (!smartDraft.diagnosis.trim()) {
      smartDraft.aiMessage = "Primero graba o escribe el diagnostico.";
      renderSmart();
      return;
    }
    const button = document.getElementById("smart-analyze-button");
    const original = button.textContent;
    try {
      button.textContent = "ANALIZANDO...";
      const result = await analyzeSmartDiagnosis(smartDraft.diagnosis);
      smartDraft.lines = result.lines;
      smartDraft.aiMessage = result.aiMessage;
      smartDraft.status = "En revision";
      speak("Leonardo, ya prepare una precotizacion editable. Revisa los conceptos, cantidades y precios antes de aprobar.");
    } finally {
      button.textContent = original;
      renderSmart();
    }
  });
  document.getElementById("smart-lines").addEventListener("input", (event) => {
    const index = Number(event.target.dataset.smartLine);
    const field = event.target.dataset.smartField;
    if (Number.isNaN(index) || !field) return;
    smartDraft.lines[index][field] = ["quantity", "price"].includes(field) ? amountFrom(event.target.value) : event.target.value;
    const line = smartDraft.lines[index];
    const importEl = event.target.closest(".smart-line")?.querySelector(".row-between strong");
    if (importEl) importEl.textContent = money(Number(line.quantity || 0) * Number(line.price || 0));
    renderSmartTotalsOnly();
  });
  document.getElementById("smart-lines").addEventListener("change", (event) => {
    const index = Number(event.target.dataset.smartLine);
    const field = event.target.dataset.smartField;
    if (Number.isNaN(index) || !field) return;
    smartDraft.lines[index][field] = event.target.value;
    renderSmart();
  });
  document.getElementById("smart-lines").addEventListener("click", (event) => {
    const index = Number(event.target.dataset.smartDelete);
    if (Number.isNaN(index)) return;
    smartDraft.lines.splice(index, 1);
    renderSmart();
  });
  document.getElementById("smart-add-line").addEventListener("click", () => {
    smartDraft.lines.push({ id: `sl-${Date.now()}`, concept: "Nuevo concepto", type: "servicio", quantity: 1, price: 0 });
    renderSmart();
  });
  document.querySelectorAll("[data-smart-status]").forEach((button) =>
    button.addEventListener("click", () => {
      smartDraft.status = button.dataset.smartStatus;
      renderSmart();
    })
  );
  document.getElementById("smart-to-draft").addEventListener("click", () => {
    draft = smartToQuoteDraft();
    document.getElementById("dictation").value = smartDraft.diagnosis;
    go("quote");
  });
  document.getElementById("smart-save-review").addEventListener("click", () => {
    if (!confirm("Guardar esta precotizacion como borrador en revision? No se enviara al cliente.")) return;
    draft = smartToQuoteDraft();
    const quote = saveQuote("Pendiente");
    if (quote) {
      quote.status = smartDraft.status === "Aprobada" ? "Aprobada" : "Pendiente";
      syncCloudState();
    }
  });
  document.getElementById("concept-list").addEventListener("input", (event) => {
    const index = Number(event.target.dataset.concept);
    const field = event.target.dataset.field;
    if (!Number.isNaN(index) && field) {
      draft.concepts[index][field] = field === "description" ? event.target.value : amountFrom(event.target.value);
      renderQuote();
    }
  });
  document.getElementById("draft-button").addEventListener("click", () => saveQuote("Pendiente"));
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
    const id =
      event.target.dataset.id ||
      event.target.dataset.edit ||
      event.target.dataset.duplicate ||
      event.target.dataset.pdf ||
      event.target.dataset.whatsapp ||
      event.target.dataset.delete;
    if (event.target.dataset.status) state.quotes = state.quotes.map((quote) => (quote.id === id ? { ...quote, status: event.target.dataset.status } : quote));
    if (event.target.dataset.edit) {
      const source = state.quotes.find((quote) => quote.id === id);
      if (source) {
        draft = structuredClone(source);
        go("quote");
        return;
      }
    }
    if (event.target.dataset.duplicate) {
      const source = state.quotes.find((quote) => quote.id === id);
      state.quotes.unshift({ ...structuredClone(source), id: `q-${Date.now()}`, folio: nextFolio(), status: "Borrador", date: new Date().toISOString(), deletedAt: undefined });
    }
    if (event.target.dataset.whatsapp) shareWhatsApp(id);
    if (event.target.dataset.pdf) {
      const quote = state.quotes.find((item) => item.id === id);
      if (quote) await sharePdf(quote, quote.folio);
    }
    if (event.target.dataset.delete) {
      const quote = state.quotes.find((item) => item.id === id);
      if (quote && confirm(`Borrar definitivamente la cotizacion ${quote.folio}?`)) {
        state.quotes = state.quotes.filter((item) => item.id !== id);
      }
    }
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
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").then((registration) => registration.update()).catch(() => undefined);
  }
  checkForAppUpdate();
  render();
}

setup();
