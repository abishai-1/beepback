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
const SERVER_VERSION = 4; // bump when the protocol changes; the client warns if the server is older
const STREAK_TZ = process.env.STREAK_TZ || undefined; // e.g. "Asia/Kolkata"; defaults to the server's zone

// Keep in sync with EMOJIS in public/app.js
const ALLOWED_EMOJIS = new Set(["❤️", "😊", "😂", "😮", "😢", "😡", "😴", "👋", "🎉", "💀"]);
// Keep in sync with COLORS in public/app.js
const ALLOWED_COLORS = new Set(["#ff7aa8", "#ff9f68", "#ffd166", "#3ddc84", "#7cc8ff", "#c77dff"]);
const ALLOWED_STATES = new Set(["awake", "asleep"]);

// ---------------------------------------------------------------------------
// State
//   rooms:    code -> { clients: Map<clientId, { socketId, state, visible }>,
//                       pending: { from, e, count, at, seenAt } | null,   // last unanswered emoji
//                       streak:  { count, day },                           // days in a row someone beeped back
//                       lastActive }
//   profiles: clientId -> { name, color, sub, lastSeen }                   // sub = Web Push subscription
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
    const clients = new Map((r.clients || []).map((id) => [id, { socketId: null, state: "awake", visible: false }]));
    rooms.set(code, { clients, pending: r.pending || null, streak: r.streak || { count: 0, day: null }, lastActive: r.lastActive || Date.now() });
  }
  for (const [id, p] of Object.entries(raw.profiles || {})) profiles.set(id, p);
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
  if (!p) { p = { name: "", color: null, sub: null, lastSeen: Date.now() }; profiles.set(clientId, p); }
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

function partnerOf(room, clientId) {
  const e = [...room.clients].find(([id]) => id !== clientId);
  return e ? { id: e[0], ...e[1] } : null;
}

// Tell everyone in the room about their partner (never sends the partner's clientId).
function broadcastPresence(code) {
  const room = rooms.get(code);
  if (!room) return;
  const p = room.pending;
  for (const [id, me] of room.clients) {
    if (!me.socketId) continue;
    const partner = partnerOf(room, id);
    const prof = partner ? profileOf(partner.id) : null;
    io.to(me.socketId).emit("partner-status", {
      paired: !!partner,
      online: !!(partner && partner.socketId),
      state: partner ? partner.state : null,
      name: prof ? prof.name : "",
      color: prof ? prof.color : null,
      streak: liveStreak(room),
      pending: p ? { mine: p.from === id, e: p.e, count: p.count, at: p.at, seen: !!p.seenAt } : null,
    });
  }
}

const touch = (room) => { room.lastActive = Date.now(); save(); };

function attach(socket, code, clientId) {
  leaveOtherRooms(clientId, code);
  const room = rooms.get(code);
  const existing = room.clients.get(clientId);
  // If the same person is connected from an old socket, drop the old one.
  if (existing && existing.socketId && existing.socketId !== socket.id) {
    const old = io.sockets.sockets.get(existing.socketId);
    if (old) { old.data.code = null; old.leave(code); old.emit("replaced"); }
  }
  room.clients.set(clientId, { socketId: socket.id, state: "awake", visible: true });
  socket.data.code = code;
  socket.data.clientId = clientId;
  socket.join(code);
  touch(room);
  broadcastPresence(code);
}

function removeClient(code, clientId) {
  const room = rooms.get(code);
  if (!room) return;
  room.clients.delete(clientId);
  room.pending = null;
  room.streak = { count: 0, day: null };
  io.to(code).emit("partner-unpaired");
  if (room.clients.size === 0) rooms.delete(code);
  else broadcastPresence(code);
  save();
}

// A person belongs to one pair at a time: joining/creating a new one leaves any old one.
function leaveOtherRooms(clientId, keepCode) {
  for (const [code, room] of rooms) {
    if (code === keepCode || !room.clients.has(clientId)) continue;
    const old = room.clients.get(clientId);
    const oldSocket = old.socketId && io.sockets.sockets.get(old.socketId);
    if (oldSocket) { oldSocket.leave(code); oldSocket.data.code = null; }
    removeClient(code, clientId);
  }
}

function detach(socket, { forget = false } = {}) {
  const { code, clientId } = socket.data;
  if (!code) return;
  socket.leave(code);
  socket.data.code = null;
  const room = rooms.get(code);
  if (!room) return;
  const me = room.clients.get(clientId);
  if (!me || me.socketId !== socket.id) return;
  if (forget) {
    socket.to(code).emit("partner-unpaired");
    room.clients.delete(clientId);
    room.pending = null;
    room.streak = { count: 0, day: null };
    if (room.clients.size === 0) { rooms.delete(code); save(); return; }
  } else {
    me.socketId = null;
    me.visible = false;
  }
  touch(room);
  broadcastPresence(code);
}

// Send a push to the partner if they aren't looking at the app right now.
function pushToPartner(code, fromId, body, tag) {
  const room = rooms.get(code);
  if (!room) return;
  const partner = partnerOf(room, fromId);
  if (!partner || (partner.socketId && partner.visible)) return;
  const prof = profiles.get(partner.id);
  if (!prof || !prof.sub) return;
  const sender = profileOf(fromId).name || "Your friend";
  const payload = JSON.stringify({ title: sender, body, tag: tag || "beepback", url: "/" });
  webpush.sendNotification(prof.sub, payload, { TTL: 24 * 3600, urgency: "high" }).catch((err) => {
    if (err.statusCode === 404 || err.statusCode === 410) { prof.sub = null; save(); } // subscription expired
    else console.warn("push failed:", err.statusCode || err.code || err.message);
  });
}

// Simple token bucket: ~10 events/second per socket.
function allow(socket) {
  const now = Date.now();
  const b = socket.data.bucket || { tokens: 10, last: now };
  b.tokens = Math.min(10, b.tokens + ((now - b.last) / 1000) * 10);
  b.last = now;
  socket.data.bucket = b;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
const safeAck = (ack) => (typeof ack === "function" ? ack : () => {});
function validSub(sub) {
  return sub && typeof sub.endpoint === "string" && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
    sub.keys && typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string" &&
    sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100;
}

// ---------------------------------------------------------------------------
// Sockets
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
    if (socket.data.code && socket.data.code !== code) detach(socket, { forget: true });
    attach(socket, code, clientId);
    ack({ ok: true, code });
  });

  socket.on("profile", (payload) => {
    const { code, clientId } = socket.data;
    if (!code || !allow(socket)) return;
    setProfile(clientId, payload);
    broadcastPresence(code);
  });

  socket.on("emoji", (payload) => {
    const { code, clientId } = socket.data;
    const e = payload && payload.e;
    if (!code || !ALLOWED_EMOJIS.has(e) || !allow(socket)) return;
    const room = rooms.get(code);
    if (!room) return;
    const at = Date.now();
    const p = room.pending;
    if (p && p.from !== clientId) bumpStreak(room); // this is a beep back!
    // Sending again before a reply bumps the count; a reply replaces the partner's emoji.
    room.pending = p && p.from === clientId
      ? { from: clientId, e, count: p.count + 1, at, seenAt: null }
      : { from: clientId, e, count: 1, at, seenAt: null };
    touch(room);
    socket.to(code).emit("emoji", { e, at });
    broadcastPresence(code);
    pushToPartner(code, clientId, `sent you ${e}`, "beepback-emoji");
  });

  socket.on("seen", () => {
    const { code, clientId } = socket.data;
    const room = code && rooms.get(code);
    const p = room && room.pending;
    if (!p || p.from === clientId || p.seenAt || !allow(socket)) return;
    p.seenAt = Date.now();
    save();
    broadcastPresence(code);
  });

  socket.on("nudge", () => {
    const { code, clientId } = socket.data;
    if (!code || !allow(socket)) return;
    socket.to(code).emit("nudge", { at: Date.now() });
    pushToPartner(code, clientId, "is thinking of you 💭", "beepback-nudge");
  });

  socket.on("hug", () => {
    const { code, clientId } = socket.data;
    if (!code || !allow(socket)) return;
    socket.to(code).emit("hug", { at: Date.now() });
    pushToPartner(code, clientId, "sent you a hug 🤗", "beepback-hug");
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
    if (me) me.visible = !!(payload && payload.visible);
  });

  socket.on("push-subscribe", (payload, ack) => {
    ack = safeAck(ack);
    const clientId = socket.data.clientId || cleanClientId(payload && payload.clientId);
    if (!clientId || !validSub(payload && payload.sub) || !allow(socket)) return ack({ ok: false });
    const s = payload.sub;
    profileOf(clientId).sub = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
    save();
    ack({ ok: true });
  });

  socket.on("push-unsubscribe", () => {
    const clientId = socket.data.clientId;
    if (clientId && profiles.has(clientId)) { profiles.get(clientId).sub = null; save(); }
  });

  socket.on("leave", () => detach(socket, { forget: true }));
  socket.on("disconnect", () => detach(socket));
});

// Forget pairs (and profiles) nobody has used for 30 days.
function sweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = [...room.clients.values()].some((c) => c.socketId);
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
