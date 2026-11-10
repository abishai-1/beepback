// BeepBack (BB): tiny realtime server
// Serves the PWA from /public, pairs two people per room over Socket.IO,
// remembers pairs (file or Upstash Redis), and sends Web Push notifications when a friend is away.

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const webpush = require("web-push");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PAIR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a pair is forgotten after 30 days with no activity
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 10000;
const MAX_PER_ROOM = 2;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
const CODE_LEN = 6;
const SERVER_VERSION = 5; // bump when the protocol changes; the client warns if the server is older
const STREAK_TZ = process.env.STREAK_TZ || undefined; // e.g. "Asia/Kolkata"; defaults to the server's zone

// Keep in sync with EMOJIS in public/app.js
const ALLOWED_EMOJIS = new Set(["❤️", "😊", "😂", "😮", "😢", "😡", "😴", "👋", "🎉", "💀"]);
// Keep in sync with COLORS in public/app.js
const ALLOWED_COLORS = new Set(["#ff7aa8", "#ff9f68", "#ffd166", "#3ddc84", "#7cc8ff", "#c77dff"]);
const ALLOWED_STATES = new Set(["awake", "asleep"]);

// ---------------------------------------------------------------------------
// State
//   rooms:    code -> { clients: Map<clientId, { sockets, visibleSockets, state }>,
//                       pending: { from, e, count, at, seenAt } | null,   // last unanswered emoji
//                       streak:  { count, day },                           // days in a row someone beeped back
//                       lastActive }
//   profiles: clientId -> { name, color, subs, fcm, lastSeen }  // subs = Web Push, fcm = Android widget tokens
// ---------------------------------------------------------------------------
const rooms = new Map();
const profiles = new Map();

// ---------------------------------------------------------------------------
// Storage: JSON files in DATA_DIR, or Upstash Redis (free tier) when its env vars are set.
// Free hosts wipe their disk on every restart, so Redis keeps pairs + push keys safe there.
// ---------------------------------------------------------------------------
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const KEY_PREFIX = process.env.STORE_PREFIX || "beepback";
const SAVE_DELAY_MS = USE_REDIS ? 2000 : 400; // batch writes (fewer Redis commands on the free plan)

async function redis(cmd, key, body) {
  const res = await fetch(`${REDIS_URL}/${cmd}/${encodeURIComponent(key)}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body,
  });
  if (!res.ok) throw new Error(`Upstash ${cmd} failed: HTTP ${res.status}`);
  return (await res.json()).result;
}
const store = {
  where: USE_REDIS ? "Upstash Redis" : DATA_DIR,
  async get(name) {
    if (USE_REDIS) return redis("get", `${KEY_PREFIX}:${name}`);
    try { return fs.readFileSync(path.join(DATA_DIR, name + ".json"), "utf8"); }
    catch (err) { if (err.code === "ENOENT") return null; throw err; }
  },
  async set(name, value) {
    if (USE_REDIS) return redis("set", `${KEY_PREFIX}:${name}`, value);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, name + ".json");
    fs.writeFileSync(file + ".tmp", value);
    fs.renameSync(file + ".tmp", file); // atomic replace so a crash never leaves half a file
  },
};

// A failed read throws, so the server refuses to start rather than overwrite saved pairs with nothing.
async function loadState() {
  const text = await store.get("state");
  if (!text) return;
  const raw = JSON.parse(text);
  for (const [code, r] of Object.entries(raw.rooms || {})) {
    const clients = new Map((r.clients || []).map((id) => [id, newClientEntry()]));
    rooms.set(code, { clients, pending: r.pending || null, streak: r.streak || { count: 0, day: null }, lastActive: r.lastActive || Date.now() });
  }
  for (const [id, p] of Object.entries(raw.profiles || {})) {
    if (p.sub && !p.subs) { p.subs = [p.sub]; delete p.sub; } // older saves had one subscription
    profiles.set(id, p);
  }
  console.log(`💾 loaded ${rooms.size} pair(s) from ${store.where}`);
}

let saveTimer = null, saving = false, dirty = false;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeState(); }, SAVE_DELAY_MS);
}
function serialize() {
  const out = { rooms: {}, profiles: {} };
  for (const [code, r] of rooms) {
    out.rooms[code] = { clients: [...r.clients.keys()], pending: r.pending, streak: r.streak, lastActive: r.lastActive };
  }
  for (const [id, p] of profiles) out.profiles[id] = p;
  return JSON.stringify(out);
}
async function writeState() {
  if (saving) { dirty = true; return; }
  saving = true;
  try { await store.set("state", serialize()); }
  catch (err) { console.warn("could not save state:", err.message); }
  saving = false;
  if (dirty) { dirty = false; save(); }
}
let exiting = false;
async function flushAndExit() {
  if (exiting) return;
  exiting = true;
  clearTimeout(saveTimer);
  setTimeout(() => process.exit(0), 5000).unref(); // never hang on shutdown
  while (saving) await new Promise((r) => setTimeout(r, 50));
  await writeState();
  process.exit(0);
}
process.on("SIGINT", flushAndExit);
process.on("SIGTERM", flushAndExit);

// ---------------------------------------------------------------------------
// Web Push: VAPID keys from env, else loaded from storage, else generated once and saved.
// ---------------------------------------------------------------------------
async function setupPush() {
  let keys = null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const saved = await store.get("vapid");
    if (saved) keys = JSON.parse(saved);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      await store.set("vapid", JSON.stringify(keys));
      console.log("🔑 generated push keys in", store.where);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:beepback@example.com", keys.publicKey, keys.privateKey);
  return keys.publicKey;
}

let VAPID_PUBLIC_KEY = null; // set during startup (see bottom of file)

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // behind Render/Railway proxies, so rate limits see real IPs
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/health", (_req, res) => res.json({ ok: true, version: SERVER_VERSION, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LEN }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}
const cleanCode = (raw) => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LEN);
function cleanClientId(raw) {
  const id = String(raw || "").slice(0, 64);
  return /^[a-zA-Z0-9-]{8,64}$/.test(id) ? id : null;
}
const cleanName = (raw) => String(raw || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 20);
const cleanColor = (raw) => (ALLOWED_COLORS.has(raw) ? raw : null);

function profileOf(clientId) {
  let p = profiles.get(clientId);
  if (!p) { p = { name: "", color: null, subs: [], fcm: [], lastSeen: Date.now() }; profiles.set(clientId, p); }
  return p;
}
function setProfile(clientId, payload) {
  const p = profileOf(clientId);
  if (payload && "name" in payload) p.name = cleanName(payload.name);
  if (payload && "color" in payload) p.color = cleanColor(payload.color);
  p.lastSeen = Date.now();
  save();
}

const dayKey = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: STREAK_TZ }); // YYYY-MM-DD
function liveStreak(room) {
  const s = room.streak;
  if (!s || !s.day) return 0;
  const now = Date.now();
  return s.day === dayKey(now) || s.day === dayKey(now - 864e5) ? s.count : 0;
}
function bumpStreak(room) {
  const now = Date.now();
  const today = dayKey(now);
  const s = room.streak || (room.streak = { count: 0, day: null });
  if (s.day === today) return;
  s.count = s.day === dayKey(now - 864e5) ? s.count + 1 : 1;
  s.day = today;
}

// ---------------------------------------------------------------------------
// People and their devices
//   One person (clientId) can have several devices at once: phone app, PC widget, Android widget…
//   Each room member is { sockets: Set<socketId>, visibleSockets: Set<socketId>, state }.
// ---------------------------------------------------------------------------
const newClientEntry = () => ({ sockets: new Set(), visibleSockets: new Set(), state: "awake" });
const isOnline = (c) => !!c && c.sockets.size > 0;
const isVisible = (c) => !!c && c.visibleSockets.size > 0;
function emitToClient(c, event, data, exceptSocketId) {
  if (!c) return;
  for (const sid of c.sockets) if (sid !== exceptSocketId) io.to(sid).emit(event, data);
}
function findRoomOf(clientId) {
  for (const [code, room] of rooms) if (room.clients.has(clientId)) return code;
  return null;
}
function partnerOf(room, clientId) {
  const e = [...room.clients].find(([id]) => id !== clientId);
  return e ? { id: e[0], entry: e[1] } : null;
}

// Everything one person needs to know about their pair (never includes the partner's clientId).
function statusFor(room, id) {
  const partner = partnerOf(room, id);
  const prof = partner ? profileOf(partner.id) : null;
  const p = room.pending;
  return {
    paired: !!partner,
    online: isOnline(partner && partner.entry),
    state: partner ? partner.entry.state : null,
    name: prof ? prof.name : "",
    color: prof ? prof.color : null,
    streak: liveStreak(room),
    pending: p ? { mine: p.from === id, e: p.e, count: p.count, at: p.at, seen: !!p.seenAt } : null,
  };
}
function broadcastPresence(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const [id, me] of room.clients) emitToClient(me, "partner-status", statusFor(room, id));
}

const touch = (room) => { room.lastActive = Date.now(); save(); };

function attach(socket, code, clientId) {
  leaveOtherRooms(clientId, code);
  const room = rooms.get(code);
  let me = room.clients.get(clientId);
  if (!me) { me = newClientEntry(); room.clients.set(clientId, me); }
  me.sockets.add(socket.id);
  me.visibleSockets.add(socket.id); // the client corrects this right away with a "visible" event
  socket.data.code = code;
  socket.data.clientId = clientId;
  socket.join(code);
  touch(room);
  broadcastPresence(code);
}

// Remove a person (all their devices) from a pair.
function removePerson(code, clientId) {
  const room = rooms.get(code);
  if (!room || !room.clients.has(clientId)) return;
  const me = room.clients.get(clientId);
  for (const sid of me.sockets) {
    const s = io.sockets.sockets.get(sid);
    if (s) { s.leave(code); s.data.code = null; s.emit("you-unpaired"); }
  }
  room.clients.delete(clientId);
  room.pending = null;
  room.streak = { count: 0, day: null };
  for (const [, other] of room.clients) emitToClient(other, "partner-unpaired");
  if (room.clients.size === 0) rooms.delete(code);
  else broadcastPresence(code);
  save();
  notifyDevices(code, null);
  sendFcmToPerson(clientId, { kind: "refresh" });
}

// A person belongs to one pair at a time: joining/creating a new one leaves any old one.
function leaveOtherRooms(clientId, keepCode) {
  for (const [code, room] of rooms) {
    if (code !== keepCode && room.clients.has(clientId)) removePerson(code, clientId);
  }
}

function detach(socket, { forget = false } = {}) {
  const { code, clientId } = socket.data;
  if (!code) return;
  const room = rooms.get(code);
  if (!room || !room.clients.has(clientId)) { socket.leave(code); socket.data.code = null; return; }
  if (forget) {
    socket.data.code = null;
    socket.leave(code);
    removePerson(code, clientId);
    return;
  }
  const me = room.clients.get(clientId);
  me.sockets.delete(socket.id);
  me.visibleSockets.delete(socket.id);
  socket.leave(code);
  socket.data.code = null;
  touch(room);
  broadcastPresence(code);
}

// ---------------------------------------------------------------------------
// Push: Web Push (browsers / installed PWA) + Firebase Cloud Messaging (Android widget app)
// ---------------------------------------------------------------------------
function webPushTo(clientId, body, tag, title) {
  const prof = profiles.get(clientId);
  if (!prof || !prof.subs || !prof.subs.length) return;
  const payload = JSON.stringify({ title, body, tag: tag || "beepback", url: "/" });
  for (const sub of [...prof.subs]) {
    webpush.sendNotification(sub, payload, { TTL: 24 * 3600, urgency: "high" }).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) { // subscription expired
        prof.subs = prof.subs.filter((x) => x.endpoint !== sub.endpoint);
        save();
      } else console.warn("push failed:", err.statusCode || err.code || err.message);
    });
  }
}

// FCM HTTP v1, signed with a service account (env FIREBASE_SERVICE_ACCOUNT = the JSON file's contents).
let fcmAccount = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) fcmAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) { console.warn("FIREBASE_SERVICE_ACCOUNT is not valid JSON:", err.message); }
let fcmToken = { value: null, exp: 0 };
async function fcmAccessToken() {
  if (fcmToken.value && Date.now() < fcmToken.exp - 60_000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: fcmAccount.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: fcmAccount.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const sig = require("crypto").sign("RSA-SHA256", Buffer.from(unsigned), fcmAccount.private_key).toString("base64url");
  const res = await fetch(fcmAccount.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error("FCM auth failed: HTTP " + res.status);
  const j = await res.json();
  fcmToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return fcmToken.value;
}
async function sendFcmToPerson(clientId, data) {
  const prof = profiles.get(clientId);
  if (!fcmAccount || !prof || !prof.fcm || !prof.fcm.length) return;
  try {
    const access = await fcmAccessToken();
    for (const token of [...prof.fcm]) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcmAccount.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, data, android: { priority: "high" } } }),
      });
      if (res.status === 404 || res.status === 400) { // token no longer valid
        prof.fcm = prof.fcm.filter((t) => t !== token);
        save();
      } else if (!res.ok) console.warn("FCM send failed: HTTP", res.status);
    }
  } catch (err) { console.warn("FCM:", err.message); }
}
// Tell every Android widget in the pair to refresh; the partner of `fromId` also gets a notification text.
function notifyDevices(code, fromId, kind, body) {
  const room = rooms.get(code);
  if (!room) return;
  for (const [id] of room.clients) {
    const data = { kind: "refresh" };
    if (fromId && id !== fromId && kind) {
      data.kind = kind;
      data.title = profileOf(fromId).name || "Your friend";
      data.body = body;
    }
    sendFcmToPerson(id, data);
  }
}
// Push to the partner if they aren't looking at BeepBack on any device right now.
function pushToPartner(code, fromId, body, tag) {
  const room = rooms.get(code);
  if (!room) return;
  const partner = partnerOf(room, fromId);
  if (!partner || isVisible(partner.entry)) return;
  webPushTo(partner.id, body, tag, profileOf(fromId).name || "Your friend");
}

// ---------------------------------------------------------------------------
// Actions (shared by sockets and the HTTP API used by the Android widget)
// ---------------------------------------------------------------------------
function doEmoji(code, clientId, e) {
  const room = rooms.get(code);
  if (!room || !ALLOWED_EMOJIS.has(e)) return false;
  const at = Date.now();
  const p = room.pending;
  if (p && p.from !== clientId) bumpStreak(room); // this is a beep back!
  // Sending again before a reply bumps the count; a reply replaces the partner's emoji.
  room.pending = p && p.from === clientId
    ? { from: clientId, e, count: p.count + 1, at, seenAt: null }
    : { from: clientId, e, count: 1, at, seenAt: null };
  touch(room);
  const partner = partnerOf(room, clientId);
  if (partner) emitToClient(partner.entry, "emoji", { e, at });
  broadcastPresence(code);
  pushToPartner(code, clientId, `sent you ${e}`, "beepback-emoji");
  notifyDevices(code, clientId, "emoji", `sent you ${e}`);
  return true;
}
function doSeen(code, clientId) {
  const room = rooms.get(code);
  const p = room && room.pending;
  if (!p || p.from === clientId || p.seenAt) return false;
  p.seenAt = Date.now();
  save();
  broadcastPresence(code);
  notifyDevices(code, null);
  return true;
}
function doSignal(code, clientId, kind) { // "nudge" | "hug"
  const room = rooms.get(code);
  if (!room) return false;
  const partner = partnerOf(room, clientId);
  if (partner) emitToClient(partner.entry, kind, { at: Date.now() });
  const body = kind === "hug" ? "sent you a hug 🤗" : "is thinking of you 💭";
  pushToPartner(code, clientId, body, "beepback-" + kind);
  notifyDevices(code, clientId, kind, body);
  return true;
}
function doProfile(code, clientId, payload) {
  setProfile(clientId, payload);
  if (code) { broadcastPresence(code); notifyDevices(code, null); }
}

// ---------------------------------------------------------------------------
// Device linking: a short one-time code lets a new device become "you" (same clientId).
// ---------------------------------------------------------------------------
const links = new Map(); // linkCode -> { clientId, exp }
const LINK_TTL_MS = 10 * 60 * 1000;
function createLink(clientId) {
  for (const [k, v] of links) if (v.clientId === clientId || v.exp < Date.now()) links.delete(k);
  let linkCode;
  do {
    linkCode = Array.from({ length: CODE_LEN }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (links.has(linkCode));
  links.set(linkCode, { clientId, exp: Date.now() + LINK_TTL_MS });
  return linkCode;
}
function redeemLink(raw) {
  const linkCode = cleanCode(raw);
  const l = links.get(linkCode);
  if (!l || l.exp < Date.now()) return null;
  links.delete(linkCode); // one use only
  const code = findRoomOf(l.clientId);
  return code ? { clientId: l.clientId, code } : null;
}

// Simple token bucket: ~10 events/second per socket (or per person for the HTTP API).
function allowBucket(holder) {
  const now = Date.now();
  const b = holder.bucket || { tokens: 10, last: now };
  b.tokens = Math.min(10, b.tokens + ((now - b.last) / 1000) * 10);
  b.last = now;
  holder.bucket = b;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
const allow = (socket) => allowBucket(socket.data);
const safeAck = (ack) => (typeof ack === "function" ? ack : () => {});
function validSub(sub) {
  return sub && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
    sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string" &&
    sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100;
}
function addSub(clientId, s) {
  const prof = profileOf(clientId);
  const sub = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
  prof.subs = [sub, ...(prof.subs || []).filter((x) => x.endpoint !== sub.endpoint)].slice(0, 5);
  save();
}

// ---------------------------------------------------------------------------
// HTTP API for the Android widget. Auth: "Authorization: Bearer <clientId>" (a linked device's secret).
// ---------------------------------------------------------------------------
const apiBuckets = new Map();
const api = express.Router();
api.use(express.json({ limit: "4kb" }));
api.post("/link", (req, res) => {
  if (!allowBucket(apiBuckets.get(req.ip) || apiBuckets.set(req.ip, {}).get(req.ip))) return res.status(429).json({ ok: false, error: "Slow down" });
  const r = redeemLink(req.body && req.body.linkCode);
  if (!r) return res.status(404).json({ ok: false, error: "That link code is wrong or expired" });
  res.json({ ok: true, clientId: r.clientId, code: r.code });
});
api.use((req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  const clientId = m && cleanClientId(m[1]);
  if (!clientId || !profiles.has(clientId)) return res.status(401).json({ ok: false, error: "Not linked" });
  const bucket = apiBuckets.get(clientId) || apiBuckets.set(clientId, {}).get(clientId);
  if (!allowBucket(bucket)) return res.status(429).json({ ok: false, error: "Slow down" });
  req.clientId = clientId;
  req.code = findRoomOf(clientId);
  next();
});
api.get("/state", (req, res) => {
  const me = profileOf(req.clientId);
  if (!req.code) return res.json({ ok: true, paired: false, me: { name: me.name, color: me.color } });
  res.json({ ok: true, code: req.code, me: { name: me.name, color: me.color }, ...statusFor(rooms.get(req.code), req.clientId) });
});
const needPair = (req, res) => { if (!req.code) { res.status(409).json({ ok: false, error: "Not paired" }); return false; } return true; };
api.post("/emoji", (req, res) => {
  if (!needPair(req, res)) return;
  res.json({ ok: doEmoji(req.code, req.clientId, req.body && req.body.e) });
});
api.post("/seen", (req, res) => { if (needPair(req, res)) res.json({ ok: doSeen(req.code, req.clientId) || true }); });
api.post("/nudge", (req, res) => { if (needPair(req, res)) res.json({ ok: doSignal(req.code, req.clientId, "nudge") }); });
api.post("/hug", (req, res) => { if (needPair(req, res)) res.json({ ok: doSignal(req.code, req.clientId, "hug") }); });
api.post("/fcm", (req, res) => {
  const token = String((req.body && req.body.token) || "");
  if (token.length < 20 || token.length > 4096) return res.status(400).json({ ok: false });
  const prof = profileOf(req.clientId);
  prof.fcm = [token, ...(prof.fcm || []).filter((t) => t !== token)].slice(0, 5);
  save();
  res.json({ ok: true, fcm: !!fcmAccount });
});
app.use("/api", api);

// ---------------------------------------------------------------------------
// Sockets (browser app + Windows widget)
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
  socket.emit("hello", { version: SERVER_VERSION, vapidKey: VAPID_PUBLIC_KEY });

  socket.on("create", (payload, ack) => {
    ack = safeAck(ack);
    if (!allow(socket)) return ack({ ok: false, error: "Slow down a little" });
    const clientId = cleanClientId(payload && payload.clientId);
    if (!clientId) return ack({ ok: false, error: "Bad client id" });
    if (rooms.size >= MAX_ROOMS) return ack({ ok: false, error: "BeepBack is full right now, try again later" });
    setProfile(clientId, payload);
    detach(socket, { forget: true });
    leaveOtherRooms(clientId, null);
    const code = makeCode();
    rooms.set(code, { clients: new Map(), pending: null, streak: { count: 0, day: null }, lastActive: Date.now() });
    attach(socket, code, clientId);
    ack({ ok: true, code });
  });

  socket.on("join", (payload, ack) => {
    ack = safeAck(ack);
    if (!allow(socket)) return ack({ ok: false, error: "Slow down a little" });
    const clientId = cleanClientId(payload && payload.clientId);
    const code = cleanCode(payload && payload.code);
    if (!clientId) return ack({ ok: false, error: "Bad client id" });
    if (code.length !== CODE_LEN) return ack({ ok: false, error: "Codes are 6 characters" });
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: "No robot with that code", gone: true });
    if (!room.clients.has(clientId) && room.clients.size >= MAX_PER_ROOM) {
      return ack({ ok: false, error: "That robot already has two friends", gone: true });
    }
    setProfile(clientId, payload);
    if (socket.data.code && socket.data.code !== code) detach(socket);
    attach(socket, code, clientId);
    ack({ ok: true, code });
  });

  socket.on("link-create", (_p, ack) => {
    ack = safeAck(ack);
    const { code, clientId } = socket.data;
    if (!code || !allow(socket)) return ack({ ok: false, error: "Pair first, then link devices" });
    ack({ ok: true, linkCode: createLink(clientId), expiresInMin: LINK_TTL_MS / 60000 });
  });
  socket.on("link-redeem", (payload, ack) => {
    ack = safeAck(ack);
    if (!allow(socket)) return ack({ ok: false, error: "Slow down a little" });
    const r = redeemLink(payload && payload.linkCode);
    if (!r) return ack({ ok: false, error: "That link code is wrong or expired" });
    ack({ ok: true, clientId: r.clientId, code: r.code });
  });

  socket.on("profile", (payload) => {
    const { code, clientId } = socket.data;
    if (!code || !allow(socket)) return;
    doProfile(code, clientId, payload);
  });

  socket.on("emoji", (payload) => {
    const { code, clientId } = socket.data;
    if (!code || !allow(socket)) return;
    doEmoji(code, clientId, payload && payload.e);
  });
  socket.on("seen", () => {
    const { code, clientId } = socket.data;
    if (code && allow(socket)) doSeen(code, clientId);
  });
  socket.on("nudge", () => {
    const { code, clientId } = socket.data;
    if (code && allow(socket)) doSignal(code, clientId, "nudge");
  });
  socket.on("hug", () => {
    const { code, clientId } = socket.data;
    if (code && allow(socket)) doSignal(code, clientId, "hug");
  });

  socket.on("activity", (payload) => {
    const { code, clientId } = socket.data;
    const state = payload && payload.state;
    if (!code || !ALLOWED_STATES.has(state) || !allow(socket)) return;
    const me = rooms.get(code) && rooms.get(code).clients.get(clientId);
    if (!me) return;
    me.state = state;
    broadcastPresence(code);
  });

  socket.on("visible", (payload) => {
    const { code, clientId } = socket.data;
    const me = code && rooms.get(code) && rooms.get(code).clients.get(clientId);
    if (!me) return;
    if (payload && payload.visible) me.visibleSockets.add(socket.id);
    else me.visibleSockets.delete(socket.id);
  });

  socket.on("push-subscribe", (payload, ack) => {
    ack = safeAck(ack);
    const clientId = socket.data.clientId || cleanClientId(payload && payload.clientId);
    if (!clientId || !validSub(payload && payload.sub) || !allow(socket)) return ack({ ok: false });
    addSub(clientId, payload.sub);
    ack({ ok: true });
  });
  socket.on("push-unsubscribe", (payload) => {
    const clientId = socket.data.clientId;
    const prof = clientId && profiles.get(clientId);
    if (!prof) return;
    const endpoint = payload && payload.endpoint;
    prof.subs = endpoint ? (prof.subs || []).filter((x) => x.endpoint !== endpoint) : [];
    save();
  });

  socket.on("leave", () => detach(socket, { forget: true }));
  socket.on("disconnect", () => detach(socket));
});

// Forget pairs (and profiles) nobody has used for 30 days.
function sweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = [...room.clients.values()].some(isOnline);
    if (!online && now - room.lastActive > PAIR_TTL_MS) rooms.delete(code);
  }
  const inRoom = new Set();
  for (const room of rooms.values()) for (const id of room.clients.keys()) inRoom.add(id);
  for (const [id, p] of profiles) if (!inRoom.has(id) && now - (p.lastSeen || 0) > PAIR_TTL_MS) profiles.delete(id);
  save();
}
setInterval(sweep, 60 * 60 * 1000).unref();

// Load saved pairs + push keys first, then start accepting connections.
(async () => {
  await loadState();
  VAPID_PUBLIC_KEY = await setupPush();
  server.listen(PORT, () => {
    console.log(`🤖 BeepBack running at http://localhost:${PORT}  (storage: ${store.where})`);
  });
})().catch((err) => {
  console.error("❌ startup failed:", err.message);
  process.exit(1);
});
