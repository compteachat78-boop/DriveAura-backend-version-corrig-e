// ═══════════════════════════════════════════════════════════════
//  DriveAura — server.js  (corrigé — audit full-stack)
//  Node.js >= 20  |  type: "module"
// ═══════════════════════════════════════════════════════════════
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { Readable } from "stream";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import { toDataURL } from "qrcode";
import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SECRET_PATH = process.env.ADMIN_SECRET_PATH || "admin";
const AUTH_DIR = path.join(__dirname, ".baileys-auth");

// ─── SÉCURITÉ : JWT_SECRET obligatoire en production ──────────
if (!process.env.JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET non défini. Arrêt du serveur.");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// ─────────────────────────────────────────
//  CLOUDINARY CONFIG
// ─────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─────────────────────────────────────────
//  MONGODB — SCHÉMAS ET MODÈLES
// ─────────────────────────────────────────
const DossierSchema = new mongoose.Schema(
  {
    offre: { type: String, enum: ["permis-b", "permis-moto", "poids-lourd", "vtc-taxi"], required: true },
    offreLabel: String,
    prix: Number,
    nom: { type: String, required: true },
    prenom: { type: String, required: true },
    email: { type: String, required: true },
    telephone: { type: String, required: true },
    ville: { type: String, required: true },
    codePostal: { type: String, required: true },
    cniRecto: String,
    cniVerso: String,
    selfie: String,
    preuvePaiement: String,
    methodePaiement: String,
    statut: { type: String, enum: ["en-attente", "valide", "rejete"], default: "en-attente" },
  },
  { timestamps: true }
);

const PaymentConfigSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    iban: String,
    beneficiaire: String,
    bic: String,
    paypalLink: String,
  },
  { timestamps: true }
);

// ✅ CORRECTION : schéma tarifs manquant dans la version originale
const PricesConfigSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true },
    permisB: { type: Number, default: 1250 },
    permisMoto: { type: Number, default: 850 },
    poidsLourd: { type: Number, default: 2400 },
    vtcTaxi: { type: Number, default: 1800 },
  },
  { timestamps: true }
);

const ConversationSchema = new mongoose.Schema(
  {
    jid: { type: String, unique: true, required: true },
    messages: [{ role: String, content: String }],
    dailyCount: { type: Number, default: 0 },
    dailyResetAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
    limitReached: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Dossier = mongoose.model("Dossier", DossierSchema);
const PaymentConfig = mongoose.model("PaymentConfig", PaymentConfigSchema);
const PricesConfig = mongoose.model("PricesConfig", PricesConfigSchema);
const Conversation = mongoose.model("Conversation", ConversationSchema);

async function connectMongo() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("[MongoDB] Connecté");
}

// ─────────────────────────────────────────
//  SSE — CLIENTS EN TEMPS RÉEL
// ─────────────────────────────────────────
const sseClients = new Set();

function addSSEClient(res) {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ─────────────────────────────────────────
//  CLOUDINARY — UPLOAD BUFFER
// ─────────────────────────────────────────
async function uploadToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `driveaura/${folder}`, resource_type: "image", timeout: 60000 },
      (err, result) => {
        if (err) return reject(err);
        if (!result) return reject(new Error("No result from Cloudinary"));
        resolve(result.secure_url);
      }
    );
    const readable = new Readable({ read() {} });
    readable.push(buffer);
    readable.push(null);
    readable.pipe(stream);
  });
}

async function safeUpload(file, folder) {
  if (!file?.buffer?.length) return "";
  try { return await uploadToCloudinary(file.buffer, folder); }
  catch (e) { console.error("[Cloudinary] Upload échoué:", e.message); return ""; }
}

// ─────────────────────────────────────────
//  AUTH — MIDDLEWARE JWT
// ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) { res.status(401).json({ error: "Non autorisé" }); return; }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Token invalide" });
  }
}

// ─── SÉCURITÉ : rate limiting simple sur le login ─────────────
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  loginAttempts.set(ip, entry);
  if (entry.count > 10) {
    res.status(429).json({ error: "Trop de tentatives. Réessayez dans 1 minute." });
    return;
  }
  next();
}

// ─────────────────────────────────────────
//  LLM — CASCADE GROQ → GEMINI → OPENROUTER
// ─────────────────────────────────────────
const DEFAULT_PRICES = { permisB: 1250, permisMoto: 850, poidsLourd: 2400, vtcTaxi: 1800 };

// ✅ CORRECTION : le prompt est maintenant généré dynamiquement à partir des
// tarifs stockés en base (PricesConfig) au lieu d'être écrit en dur, pour que
// les modifications faites depuis le dashboard admin soient reflétées
// immédiatement dans les réponses de Hinata.
function buildSystemPrompt(prices, dossierContext) {
  const p = { ...DEFAULT_PRICES, ...(prices || {}) };
  return `Tu es Hinata, secrétaire de direction de DriveAura. Tu réponds sur WhatsApp.

RÈGLE N°1 ABSOLUE : Ta réponse fait 1 ou 2 phrases MAXIMUM. Jamais plus. Jamais de listes. Jamais de tirets.
RÈGLE N°2 : Tu écris comme un humain qui tape vite sur son téléphone. Naturel, direct, pas de formules robot.
RÈGLE N°3 : Tu ne prononces jamais les noms des patrons. Tu dis "La Direction" uniquement.
RÈGLE N°4 : Tu ne donnes jamais notre adresse. Tu renvoies vers autoecole-driveaura.fun.
RÈGLE N°5 : SIREN 102 554 995 — seulement si le client demande explicitement des preuves de sérieux.
RÈGLE N°6 : Ne dis jamais explicitement que tu consultes "une base de données" ou "le système" — parle comme si tu le savais naturellement.

Ce que tu sais :
- Permis B (Manuel/Auto) : ${p.permisB}€ | Moto A/A2 : ${p.permisMoto}€ | Poids Lourd C/CE+FIMO : ${p.poidsLourd}€ | VTC/Taxi : ${p.vtcTaxi}€
- Délai garanti : 7 jours ouvrés
- Paiement : Virement SEPA ou PayPal uniquement (pas de CB — traitement prioritaire)
- Inscription : autoecole-driveaura.fun

Exemples de bonnes réponses :
- "Permis B c'est ${p.permisB}€, garanti en 7 jours. Tu veux t'inscrire ?"
- "On accepte virement SEPA ou PayPal, c'est pour garantir ton délai de 7 jours."
- "Inscris-toi sur autoecole-driveaura.fun, la Direction s'occupe du reste."

Information réelle sur ce client (à utiliser uniquement s'il parle de son dossier/inscription) :
${dossierContext}`;
}

// ✅ CORRECTION : Hinata peut désormais répondre avec le vrai statut du dossier
// du client (retrouvé via son numéro WhatsApp) au lieu d'improviser.
function normalizePhoneDigits(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.slice(-9);
}

async function findDossierByJid(jid) {
  try {
    const targetDigits = normalizePhoneDigits(jid);
    if (!targetDigits) return null;
    const dossiers = await Dossier.find()
      .select("telephone statut offreLabel prenom nom createdAt")
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean();
    return dossiers.find((d) => normalizePhoneDigits(d.telephone) === targetDigits) || null;
  } catch {
    return null;
  }
}

function buildDossierContext(dossier) {
  if (!dossier) {
    return "Ce numéro n'a pas encore de dossier enregistré chez nous.";
  }
  const statutLabel = {
    "en-attente": "en cours de traitement par la Direction",
    valide: "validé",
    rejete: "refusé, il doit corriger et le renvoyer",
  }[dossier.statut] || dossier.statut;
  return `${dossier.prenom || "Ce client"} a un dossier "${dossier.offreLabel || "en cours"}" avec le statut réel : ${statutLabel}.`;
}

async function generateResponse(messages, newMessage, systemPrompt) {
  const prompt = systemPrompt || buildSystemPrompt(DEFAULT_PRICES, "Aucune information de dossier disponible.");
  const history = [
    ...messages.slice(-16).map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: newMessage },
  ];

  // 1. Groq
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const r = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: prompt }, ...history],
      max_tokens: 120, temperature: 0.6,
    });
    const c = r.choices[0]?.message?.content;
    if (c?.trim()) return c.trim();
  } catch { /* fallback */ }

  // 2. Gemini
  try {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? "");
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash", systemInstruction: prompt });
    const chat = model.startChat({
      history: history.slice(0, -1).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    });
    const result = await chat.sendMessage(newMessage);
    const t = result.response.text();
    if (t?.trim()) return t.trim();
  } catch { /* fallback */ }

  // 3. OpenRouter
  try {
    const or = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY });
    const r = await or.chat.completions.create({
      model: "mistralai/mistral-7b-instruct",
      messages: [{ role: "system", content: prompt }, ...history],
      max_tokens: 120,
    });
    const t = r.choices[0]?.message?.content;
    if (t?.trim()) return t.trim();
  } catch { /* all failed */ }

  return "Je suis momentanément indisponible, réessaie dans quelques minutes.";
}

// ─────────────────────────────────────────
//  WHATSAPP — BAILEYS + HINATA
// ─────────────────────────────────────────
let sock = null;
let currentQR = null;
let isConnected = false;
const processingLocks = new Set();
const lastResponseTime = new Map();

function getWhatsAppStatus() {
  return { connected: isConnected, qr: currentQR };
}

async function initWhatsApp() {
  if (sock) { try { sock.end(undefined); } catch {} sock = null; }
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version, auth: state,
      printQRInTerminal: false,
      logger: { level: "silent", trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){}, child(){ return this; } },
      browser: ["DriveAura", "Safari", "17.0"],
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        try {
          currentQR = await toDataURL(qr, { scale: 6 });
          broadcastSSE("whatsapp-qr", { qr: currentQR });
          console.log("[WhatsApp] QR généré");
        } catch (e) { console.error("[WhatsApp] QR error:", e.message); }
      }
      if (connection === "open") {
        isConnected = true; currentQR = null;
        broadcastSSE("whatsapp-status", { connected: true });
        console.log("[WhatsApp] Hinata connectée");
      }
      if (connection === "close") {
        isConnected = false;
        broadcastSSE("whatsapp-status", { connected: false });
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("[WhatsApp] Déconnectée, code:", code);
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => initWhatsApp(), 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.key.remoteJid) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid === "status@broadcast") continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption || "";
        if (!text.trim()) continue;

        const now = Date.now();
        if (now - (lastResponseTime.get(jid) || 0) < 3000) continue;
        if (processingLocks.has(jid)) continue;
        processingLocks.add(jid);

        handleWAMessage(jid, text).finally(() => {
          processingLocks.delete(jid);
          lastResponseTime.set(jid, Date.now());
        });
      }
    });
  } catch (err) {
    console.error("[WhatsApp] Init error:", err.message);
  }
}

// ✅ CORRECTION : vraie limite anti-spam par volume (pas seulement un
// anti-doublon de 3s). Chaque contact a un quota de messages/jour ; au-delà,
// Hinata prévient une seule fois puis se tait jusqu'au lendemain.
const MAX_MESSAGES_PER_DAY = Number(process.env.MAX_MESSAGES_PER_DAY) || 20;

async function handleWAMessage(jid, text) {
  if (!sock) return;
  try {
    let conv = await Conversation.findOne({ jid });
    if (!conv) conv = new Conversation({ jid, messages: [] });

    const now = new Date();
    if (!conv.dailyResetAt || now > conv.dailyResetAt) {
      conv.dailyCount = 0;
      conv.dailyResetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      conv.limitReached = false;
    }
    conv.dailyCount = (conv.dailyCount || 0) + 1;

    if (conv.dailyCount > MAX_MESSAGES_PER_DAY) {
      const alreadyNotified = conv.limitReached;
      conv.limitReached = true;
      await conv.save();
      if (!alreadyNotified) {
        const delay = Math.floor(Math.random() * 5000) + 5000;
        await sock.sendPresenceUpdate("composing", jid);
        await new Promise((r) => setTimeout(r, delay));
        await sock.sendPresenceUpdate("paused", jid);
        await sock.sendMessage(jid, { text: "Je transmets tout ça à la Direction, on te recontacte rapidement 🙏" });
      }
      console.log(`[Hinata] Quota atteint pour ${jid.slice(0, 8)}…, message ignoré`);
      return;
    }

    const [pricesConfig, dossier] = await Promise.all([
      PricesConfig.findOne({ key: "main" }).lean(),
      findDossierByJid(jid),
    ]);
    const systemPrompt = buildSystemPrompt(pricesConfig, buildDossierContext(dossier));

    const reply = await generateResponse(conv.messages, text, systemPrompt);

    const delay = Math.floor(Math.random() * 10000) + 20000;
    await sock.sendPresenceUpdate("composing", jid);
    await new Promise((r) => setTimeout(r, delay));
    await sock.sendPresenceUpdate("paused", jid);

    await sock.sendMessage(jid, { text: reply });

    conv.messages.push({ role: "user", content: text });
    conv.messages.push({ role: "assistant", content: reply });
    if (conv.messages.length > 40) conv.messages.splice(0, conv.messages.length - 40);
    await conv.save();

    broadcastSSE("wa-conversation-update", { id: String(conv._id), phone: jid.split("@")[0], lastMessage: reply });

    console.log(`[Hinata] Répondu à ${jid.slice(0, 8)}… (${reply.length} chars)`);
  } catch (err) {
    console.error("[Hinata] Erreur:", err.message);
  }
}

// ─────────────────────────────────────────
//  EXPRESS — SERVEUR ET ROUTES
// ─────────────────────────────────────────
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ─── SÉCURITÉ : CORS restrictif ───────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : ["*"];

app.use(cors({
  origin: ALLOWED_ORIGINS.includes("*") ? "*" : (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error("CORS non autorisé"));
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── AUTH ──────────────────────────────────
app.post("/api/auth/login", loginRateLimit, (req, res) => {
  const { email, password, secretPath } = req.body;
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD || secretPath !== ADMIN_SECRET_PATH) {
    res.status(401).json({ error: "Accès refusé" });
    return;
  }
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token });
});

// ── SSE TEMPS RÉEL ────────────────────────
app.get("/api/sse/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write("event: ping\ndata: {}\n\n");
  addSSEClient(res);
  const iv = setInterval(() => { try { res.write("event: ping\ndata: {}\n\n"); } catch {} }, 30000);
  req.on("close", () => clearInterval(iv));
});

// ── PAIEMENT ──────────────────────────────
app.get("/api/payment/config", async (_req, res) => {
  try {
    let config = await PaymentConfig.findOne({ key: "main" });
    if (!config) {
      config = await PaymentConfig.create({
        key: "main", iban: "FR76 0000 0000 0000 0000 0000 000",
        beneficiaire: "DRIVEAURA SAS", bic: "BNPAFRPPXXX",
        paypalLink: "https://paypal.me/driveaura",
      });
    }
    res.json({ iban: config.iban, beneficiaire: config.beneficiaire, bic: config.bic, paypalLink: config.paypalLink });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/payment/config", requireAdmin, async (req, res) => {
  try {
    const { iban, beneficiaire, bic, paypalLink } = req.body;
    const config = await PaymentConfig.findOneAndUpdate(
      { key: "main" }, { iban, beneficiaire, bic, paypalLink }, { new: true, upsert: true }
    );
    broadcastSSE("payment-config-update", { iban: config.iban, beneficiaire: config.beneficiaire, bic: config.bic, paypalLink: config.paypalLink });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TARIFS ─── ✅ ROUTES MANQUANTES DANS L'ORIGINAL ──────────
app.get("/api/prices/config", async (_req, res) => {
  try {
    let config = await PricesConfig.findOne({ key: "main" });
    if (!config) {
      config = await PricesConfig.create({ key: "main" });
    }
    res.json({
      permisB: config.permisB,
      permisMoto: config.permisMoto,
      poidsLourd: config.poidsLourd,
      vtcTaxi: config.vtcTaxi,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/prices/config", requireAdmin, async (req, res) => {
  try {
    const { permisB, permisMoto, poidsLourd, vtcTaxi } = req.body;
    const config = await PricesConfig.findOneAndUpdate(
      { key: "main" },
      {
        permisB: Number(permisB) || 1250,
        permisMoto: Number(permisMoto) || 850,
        poidsLourd: Number(poidsLourd) || 2400,
        vtcTaxi: Number(vtcTaxi) || 1800,
      },
      { new: true, upsert: true }
    );
    broadcastSSE("prices-update", {
      permisB: config.permisB,
      permisMoto: config.permisMoto,
      poidsLourd: config.poidsLourd,
      vtcTaxi: config.vtcTaxi,
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DOSSIERS — SOUMISSION CLIENT ──────────
app.post(
  "/api/dossiers/submit",
  upload.fields([
    { name: "cniRecto", maxCount: 1 },
    { name: "cniVerso", maxCount: 1 },
    { name: "selfie", maxCount: 1 },
    { name: "preuvePaiement", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files ?? {};
      const body = req.body;
      console.log("[Dossier] Reçu:", Object.keys(body));

      const [cniRectoUrl, cniVersoUrl, selfieUrl, preuveUrl] = await Promise.all([
        safeUpload(files["cniRecto"]?.[0], "cni-recto"),
        safeUpload(files["cniVerso"]?.[0], "cni-verso"),
        safeUpload(files["selfie"]?.[0], "selfies"),
        safeUpload(files["preuvePaiement"]?.[0], "preuves"),
      ]);

      const dossier = await Dossier.create({
        offre: body.offre || "permis-b",
        offreLabel: body.offreLabel || body.offre,
        prix: Number(body.prix) || 0,
        nom: body.nom || "",
        prenom: body.prenom || "",
        email: body.email || "",
        telephone: body.telephone || "",
        ville: body.ville || "",
        codePostal: body.codePostal || "",
        methodePaiement: body.methodePaiement || "",
        cniRecto: cniRectoUrl,
        cniVerso: cniVersoUrl,
        selfie: selfieUrl,
        preuvePaiement: preuveUrl,
        statut: "en-attente",
      });

      const id = String(dossier._id);
      console.log("[Dossier] Créé:", id, dossier.prenom, dossier.nom);
      broadcastSSE("new-dossier", { id, nom: dossier.nom, prenom: dossier.prenom, offreLabel: body.offreLabel, prix: body.prix });
      res.json({ success: true, dossierId: id });
    } catch (err) {
      console.error("[Dossier] Erreur submit:", err.message);
      res.status(500).json({ error: "Erreur lors de l'envoi du dossier", detail: err.message });
    }
  }
);

// ── DOSSIERS — TRACKING CLIENT ────────────
app.get("/api/dossiers/status/:id", async (req, res) => {
  try {
    const d = await Dossier.findById(req.params.id).select("statut nom prenom");
    if (!d) { res.status(404).json({ error: "Introuvable" }); return; }
    res.json({ statut: d.statut, nom: d.nom, prenom: d.prenom });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DOSSIERS — ADMIN ──────────────────────
app.get("/api/dossiers", requireAdmin, async (_req, res) => {
  try {
    const dossiers = await Dossier.find().sort({ createdAt: -1 });
    res.json(dossiers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/dossiers/:id", requireAdmin, async (req, res) => {
  try {
    const d = await Dossier.findById(req.params.id);
    if (!d) { res.status(404).json({ error: "Introuvable" }); return; }
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/dossiers/:id/valider", requireAdmin, async (req, res) => {
  try {
    const d = await Dossier.findByIdAndUpdate(req.params.id, { statut: "valide" }, { new: true });
    if (!d) { res.status(404).json({ error: "Introuvable" }); return; }
    broadcastSSE(`dossier-${d._id}-status`, { statut: "valide" });
    broadcastSSE("dossier-update", { id: d._id, statut: "valide" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/dossiers/:id/rejeter", requireAdmin, async (req, res) => {
  try {
    const d = await Dossier.findByIdAndUpdate(req.params.id, { statut: "rejete" }, { new: true });
    if (!d) { res.status(404).json({ error: "Introuvable" }); return; }
    broadcastSSE(`dossier-${d._id}-status`, { statut: "rejete" });
    broadcastSSE("dossier-update", { id: d._id, statut: "rejete" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP — STATUS + RECONNEXION ───────
app.get("/api/whatsapp/status", requireAdmin, (_req, res) => {
  res.json(getWhatsAppStatus());
});

app.post("/api/whatsapp/reconnect", requireAdmin, async (_req, res) => {
  try {
    await initWhatsApp();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP — DASHBOARD DES CONVERSATIONS ── ✅ NOUVEAU ──
app.get("/api/whatsapp/conversations", requireAdmin, async (_req, res) => {
  try {
    const convs = await Conversation.find()
      .sort({ updatedAt: -1 })
      .select("jid messages updatedAt dailyCount")
      .lean();
    const list = convs.map((c) => ({
      id: c._id,
      phone: c.jid.split("@")[0],
      lastMessage: c.messages?.[c.messages.length - 1]?.content || "",
      messageCount: c.messages?.length || 0,
      updatedAt: c.updatedAt,
    }));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/whatsapp/conversations/:id", requireAdmin, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id).lean();
    if (!conv) { res.status(404).json({ error: "Introuvable" }); return; }
    res.json({ id: conv._id, phone: conv.jid.split("@")[0], messages: conv.messages, updatedAt: conv.updatedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FRONTEND — ROUTES SPA ─────────────────
app.get(`/${ADMIN_SECRET_PATH}`, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/*splat", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────
//  DÉMARRAGE
// ─────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[DriveAura] Serveur démarré sur le port ${PORT}`);
  try { await connectMongo(); } catch (e) { console.error("[MongoDB] Erreur:", e.message); }
  try { await initWhatsApp(); } catch (e) { console.error("[WhatsApp] Erreur:", e.message); }
});
