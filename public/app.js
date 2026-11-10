// BeepBack (BB): client
(() => {
  "use strict";

  // ---------- config ----------
  // Every emoji has its own face. Keep in sync with ALLOWED_EMOJIS in server.js
  const EMOJIS = [
    { e: "❤️", exp: "love",      notes: [660, 880, 1046] },                 // ♥ ♥ heart eyes
    { e: "😊", exp: "happy",     notes: [523, 659, 784] },                  // ^ ^ soft smile
    { e: "😂", exp: "laugh",     notes: [784, 659, 784, 659, 988] },        // > < giggling, tears of joy
    { e: "😮", exp: "surprised", notes: [440, 880] },                       // O O
    { e: "😢", exp: "sad",       notes: [523, 466, 392] },                  // droopy eyes + tear
    { e: "😡", exp: "angry",     notes: [220, 196, 220], wave: "square" },  // slanted brows + shake
    { e: "😴", exp: "sleepy",    notes: [392, 330, 262] },                  // closed eyes + zzz
    { e: "👋", exp: "wink",      notes: [587, 784] },                       // wink + tilt
    { e: "🎉", exp: "party",     notes: [523, 659, 784, 1046], confetti: true }, // ★ ★ star eyes + bounce
    { e: "💀", exp: "dead",      notes: [392, 370, 349, 330, 196], wave: "triangle" }, // X X + tongue
  ];
  // Keep in sync with ALLOWED_COLORS in server.js
  const COLORS = ["#ff7aa8", "#ff9f68", "#ffd166", "#3ddc84", "#7cc8ff", "#c77dff"];
  const DEFAULT_COLOR = COLORS[0];
  const NEEDS_SERVER_VERSION = 5;
  // Widget mode: the Windows desktop widget loads /?widget=1 (remembered for the session).
  const IS_WIDGET = (() => {
    try {
      if (new URLSearchParams(location.search).get("widget") === "1") sessionStorage.setItem("bb.widget", "1");
      return sessionStorage.getItem("bb.widget") === "1" || !!window.bbDesktop;
    } catch { return !!window.bbDesktop; }
  })();
  if (IS_WIDGET) document.body.classList.add("widget");
  // Inside the Windows app: a small "hide to tray" button (the window has no title bar).
  if (window.bbDesktop) {
    const hide = document.createElement("button");
    hide.className = "widget-hide";
    hide.title = "Hide (BeepBack stays in the tray)";
    hide.textContent = "✕";
    hide.addEventListener("click", () => window.bbDesktop.hide());
    document.body.appendChild(hide);
  }
  const SLEEP_AFTER_MS = 60_000;
  const HUG_HOLD_MS = 900;
  const LS = {
    code: "smtgu.code", clientId: "smtgu.clientId", sound: "smtgu.sound", vibe: "smtgu.vibe",
    name: "bb.name", color: "bb.color", notif: "bb.notif", notifAsked: "bb.notifAsked",
  };

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const rand = (a, b) => a + Math.random() * (b - a);

  function getClientId() {
    let id = store.get(LS.clientId);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2, 12);
      store.set(LS.clientId, id);
    }
    return id;
  }

  const el = {
    face: $("face"), eyes: $("eyes"), hint: $("hint"), faceWrap: $("faceWrap"), hugHeart: $("hugHeart"),
    bubble: $("bubble"), bubbleEmoji: $("bubbleEmoji"), bubbleCount: $("bubbleCount"), bubbleCaption: $("bubbleCaption"),
    bar: $("bar"), statusDot: $("statusDot"), statusText: $("statusText"), codeChip: $("codeChip"), streak: $("streak"),
    emojiBar: $("emojiBar"), fx: $("fx"), toast: $("toast"), offline: $("offline"),
    notifyCard: $("notifyCard"), notifyName: $("notifyName"),
    pairSheet: $("pairSheet"), pairChoose: $("pairChoose"), pairWaiting: $("pairWaiting"),
    bigCode: $("bigCode"), codeInput: $("codeInput"), nameInput: $("nameInput"), pairError: $("pairError"),
    settingsSheet: $("settingsSheet"), settingsName: $("settingsName"), swatches: $("swatches"),
    notifyBtn: $("notifyBtn"), notifyNote: $("notifyNote"),
    soundToggle: $("soundToggle"), vibeToggle: $("vibeToggle"), installBtn: $("installBtn"),
    linkBtn: $("linkBtn"), linkPanel: $("linkPanel"), linkCode: $("linkCode"), linkExpiry: $("linkExpiry"),
    showLinkBtn: $("showLinkBtn"), linkForm: $("linkForm"), linkInput: $("linkInput"),
  };

  const state = {
    clientId: getClientId(),
    code: null,
    paired: false,
    partnerOnline: false,
    partnerName: "",
    streak: 0,
    asleep: false,
    tempTimer: null,
    tempActive: false,
    lastInput: Date.now(),
    sound: store.get(LS.sound) !== "0",
    vibe: store.get(LS.vibe) !== "0",
    name: store.get(LS.name) || "",
    color: COLORS.includes(store.get(LS.color)) ? store.get(LS.color) : DEFAULT_COLOR,
    pending: null, // last unanswered emoji from the server: { mine, e, count, at, seen }
    vapidKey: null,
  };
  el.soundToggle.checked = state.sound;
  el.vibeToggle.checked = state.vibe;
  el.nameInput.value = state.name;
  el.settingsName.value = state.name;

  const friend = () => state.partnerName || "your friend";
  const Friend = () => state.partnerName || "Your friend";

  // ---------- sound (Web Audio, no files) ----------
  let audioCtx = null;
  function unlockAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }
  ["pointerdown", "keydown"].forEach((t) => window.addEventListener(t, unlockAudio, { passive: true }));

  function beep(notes, wave = "sine", step = 0.09) {
    if (!state.sound || !audioCtx) return;
    const t0 = audioCtx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = wave;
      o.frequency.value = f;
      const t = t0 + i * step;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(wave === "square" ? 0.05 : 0.15, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + step * 1.6);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + step * 1.8);
    });
  }
  function vibrate(pattern) {
    if (state.vibe && navigator.vibrate) navigator.vibrate(pattern);
  }
  // In the Windows widget, show a desktop notification when the widget isn't focused.
  function desktopNotify(body) {
    if (!IS_WIDGET || document.hasFocus() || !("Notification" in window)) return;
    try {
      if (Notification.permission === "granted") new Notification(Friend(), { body, icon: "/icons/icon-192.png", silent: true });
      else if (Notification.permission === "default") Notification.requestPermission();
    } catch {}
  }

  // ---------- face: blink, look, expressions, sleep ----------
  function blink(times = 1) {
    if (state.asleep || el.face.dataset.exp) return;
    let n = 0;
    const once = () => {
      el.face.classList.add("blink");
      setTimeout(() => {
        el.face.classList.remove("blink");
        if (++n < times) setTimeout(once, 140);
      }, 110);
    };
    once();
  }
  (function blinkLoop() {
    setTimeout(() => { blink(Math.random() < 0.2 ? 2 : 1); blinkLoop(); }, rand(2000, 6000));
  })();

  function look(x, y) {
    const r = el.face.getBoundingClientRect();
    const dx = Math.max(-1, Math.min(1, (x - (r.left + r.width / 2)) / (window.innerWidth / 2)));
    const dy = Math.max(-1, Math.min(1, (y - (r.top + r.height / 2)) / (window.innerHeight / 2)));
    el.eyes.style.setProperty("--lx", dx.toFixed(3));
    el.eyes.style.setProperty("--ly", dy.toFixed(3));
  }
  function lookCenter() {
    el.eyes.style.setProperty("--lx", 0);
    el.eyes.style.setProperty("--ly", 0);
  }
  setInterval(() => {
    if (Date.now() - state.lastInput > 4000 && !state.asleep) {
      el.eyes.style.setProperty("--lx", rand(-0.6, 0.6).toFixed(2));
      el.eyes.style.setProperty("--ly", rand(-0.4, 0.4).toFixed(2));
    }
  }, 3000);

  // The "held" expression comes from the partner's unanswered emoji and stays until we reply.
  function heldExp() {
    const p = state.pending;
    if (!p || p.mine) return null;
    const item = EMOJIS.find((x) => x.e === p.e);
    return item ? item.exp : null;
  }
  function showExp(exp, { restart = false } = {}) {
    el.face.classList.remove("blink");
    if (!exp) { delete el.face.dataset.exp; return; }
    if (el.face.dataset.exp === exp && !restart) return;
    el.face.dataset.exp = "";
    void el.face.offsetWidth; // restart CSS animations
    el.face.dataset.exp = exp;
  }
  function applyFace() {
    if (state.asleep || state.tempActive) return;
    showExp(heldExp());
  }
  // Briefly show an expression, then go back to the held one.
  function flashExp(exp, ms = 2600) {
    clearTimeout(state.tempTimer);
    state.tempActive = true;
    showExp(exp, { restart: true });
    state.tempTimer = setTimeout(() => { state.tempActive = false; applyFace(); }, ms);
  }

  function setAsleep(asleep) {
    if (state.asleep === asleep) return;
    state.asleep = asleep;
    el.face.classList.toggle("asleep", asleep);
    if (asleep) { lookCenter(); delete el.face.dataset.exp; }
    else applyFace();
    if (socket.connected && state.code) socket.emit("activity", { state: asleep ? "asleep" : "awake" });
  }
  function poke() {
    state.lastInput = Date.now();
    if (state.asleep) setAsleep(false);
  }
  setInterval(() => {
    // Stay awake while holding the friend's emoji, so the expression keeps showing.
    if (!state.asleep && !heldExp() && Date.now() - state.lastInput > SLEEP_AFTER_MS) setAsleep(true);
  }, 2000);

  window.addEventListener("pointermove", (ev) => { poke(); if (!state.asleep) look(ev.clientX, ev.clientY); }, { passive: true });
  window.addEventListener("pointerdown", (ev) => { poke(); look(ev.clientX, ev.clientY); }, { passive: true });
  window.addEventListener("keydown", poke);

  // ---------- fx ----------
  function floatEmoji(e, { small = false, count = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      const s = document.createElement("span");
      s.className = "float-emoji" + (small ? " small" : "");
      s.textContent = e;
      s.style.left = (small ? rand(35, 65) : rand(15, 80)) + "vw";
      s.style.setProperty("--rot", rand(-25, 25) + "deg");
      s.style.animationDelay = i * 120 + "ms";
      el.fx.appendChild(s);
      s.addEventListener("animationend", () => s.remove());
    }
  }
  function confetti() {
    const colors = ["#ff7aa8", "#ffd166", "#7cc8ff", "#3ddc84", "#ffffff", "#c77dff"];
    for (let i = 0; i < 70; i++) {
      const c = document.createElement("i");
      c.className = "confetti";
      c.style.left = rand(0, 100) + "vw";
      c.style.background = colors[i % colors.length];
      c.style.setProperty("--dx", rand(-20, 20) + "vw");
      c.style.setProperty("--d", rand(1.4, 2.6) + "s");
      c.style.animationDelay = rand(0, 0.4) + "s";
      el.fx.appendChild(c);
      c.addEventListener("animationend", () => c.remove());
    }
  }
  let toastTimer;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
  }
  function burstHeart() {
    el.hugHeart.classList.remove("burst");
    void el.hugHeart.offsetWidth;
    el.hugHeart.classList.add("burst");
  }
  el.hugHeart.addEventListener("animationend", () => el.hugHeart.classList.remove("burst"));

  // ---------- held emoji bubble + "seen" ----------
  function renderPending(p) {
    const key = (q) => q && `${q.mine}|${q.e}|${q.count}`;
    const changed = key(state.pending) !== key(p);
    state.pending = p || null;
    if (!p) {
      el.bubble.hidden = true;
    } else {
      el.bubble.hidden = false;
      el.bubble.classList.toggle("outgoing", !!p.mine);
      el.bubbleEmoji.textContent = p.e;
      el.bubbleCount.hidden = !(p.count > 1);
      el.bubbleCount.textContent = "×" + p.count;
      el.bubbleCaption.textContent = p.mine ? (p.seen ? "seen 👀" : "waiting for reply…") : "";
      el.bubbleCaption.hidden = !p.mine;
      if (changed) {
        el.bubble.classList.remove("pop");
        void el.bubble.offsetWidth;
        el.bubble.classList.add("pop");
      }
    }
    applyFace();
    markSeen();
  }
  // Tell the sender we've actually looked at their emoji.
  function markSeen() {
    const p = state.pending;
    if (p && !p.mine && !p.seen && !document.hidden && socket.connected) socket.emit("seen");
  }

  // ---------- emoji bar ----------
  EMOJIS.forEach((item) => {
    const b = document.createElement("button");
    b.className = "emoji-btn";
    b.textContent = item.e;
    b.setAttribute("aria-label", "Send " + item.e);
    b.addEventListener("click", () => sendEmoji(item, b));
    el.emojiBar.appendChild(b);
  });

  function sendEmoji(item, btn) {
    if (!state.paired) return;
    const wasReply = state.pending && !state.pending.mine;
    socket.emit("emoji", { e: item.e });
    // show it in our bubble right away; the server's status update confirms it
    const p = state.pending;
    renderPending({ mine: true, e: item.e, count: p && p.mine ? p.count + 1 : 1, at: Date.now(), seen: false });
    floatEmoji(item.e, { small: true });
    el.face.classList.remove("sent");
    void el.face.offsetWidth;
    el.face.classList.add("sent");
    beep([item.notes[0] * 2], "sine", 0.05);
    vibrate(15);
    toast(wasReply ? "beeped back ✓" : state.partnerOnline ? "sent ✓" : `sent ✓ (${friend()} will get a ping)`, 1100);
    btn.classList.add("cooldown");
    setTimeout(() => btn.classList.remove("cooldown"), 250);
  }

  function receiveEmoji(e) {
    const item = EMOJIS.find((x) => x.e === e);
    if (!item) return;
    poke();
    clearTimeout(state.tempTimer);
    state.tempActive = false;
    showExp(item.exp, { restart: true }); // replay the animation; it then stays held
    floatEmoji(e, { count: 3 });
    beep(item.notes, item.wave);
    vibrate(40);
    if (item.confetti) confetti();
    desktopNotify(`sent you ${e}`);
  }

  // ---------- tap = nudge, hold = hug ----------
  let lastNudge = 0, lastHug = 0, holdTimer = null, hugFired = false;
  function sendNudge() {
    if (!state.paired) return;
    const now = Date.now();
    if (now - lastNudge < 1200) return;
    lastNudge = now;
    socket.emit("nudge");
    floatEmoji("💭", { small: true });
    beep([880, 1175], "triangle", 0.07);
    toast("💭 nudge sent", 1000);
  }
  function receiveNudge() {
    poke();
    el.face.classList.add("nudged");
    setTimeout(() => el.face.classList.remove("nudged"), 2500);
    setTimeout(() => blink(2), 150);
    floatEmoji("💗", { count: 2 });
    beep([1175, 880, 1175], "triangle", 0.08);
    vibrate([80, 40, 80]);
    toast(`💭 ${friend()} is thinking of you`);
    desktopNotify("is thinking of you 💭");
  }
  function sendHug() {
    const now = Date.now();
    if (now - lastHug < 3000) return;
    lastHug = now;
    socket.emit("hug");
    burstHeart();
    beep([523, 659, 784, 659, 523], "sine", 0.08);
    vibrate([30, 30, 60]);
    toast("🤗 hug sent", 1200);
  }
  function receiveHug() {
    poke();
    burstHeart();
    flashExp("love", 2600);
    el.face.classList.add("nudged");
    setTimeout(() => el.face.classList.remove("nudged"), 2600);
    floatEmoji("🤗", { count: 2 });
    beep([523, 659, 784, 1046, 784], "sine", 0.1);
    vibrate([200, 80, 200]);
    toast(`🤗 ${friend()} sent you a hug`);
    desktopNotify("sent you a hug 🤗");
  }

  function cancelHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    el.faceWrap.classList.remove("hugging");
  }
  el.face.addEventListener("pointerdown", () => {
    if (!state.paired) return;
    hugFired = false;
    el.faceWrap.classList.add("hugging");
    holdTimer = setTimeout(() => { hugFired = true; cancelHold(); sendHug(); }, HUG_HOLD_MS);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => el.face.addEventListener(t, cancelHold));
  el.face.addEventListener("contextmenu", (ev) => ev.preventDefault()); // long-press menu on phones
  el.face.addEventListener("click", () => {
    if (hugFired) { hugFired = false; return; } // that press was a hug, not a tap
    sendNudge();
  });
  el.face.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); sendNudge(); }
    if (ev.key === "h" || ev.key === "H") sendHug();
  });

  // ---------- status, name, color, streak ----------
  function renderStatus(s) {
    state.paired = !!s.paired;
    state.partnerOnline = !!s.online;
    state.partnerName = s.name || "";
    el.statusDot.className = "dot" + (s.online ? (s.state === "asleep" ? " asleep" : " online") : "");
    el.statusText.textContent = !s.paired ? "waiting for friend…"
      : !s.online ? `${Friend()} is away`
      : s.state === "asleep" ? `${Friend()} is sleeping 😴`
      : `${Friend()} is here ✨`;
    // Your robot wears your friend's color (and theirs wears yours).
    document.documentElement.style.setProperty("--blush", s.paired && s.color ? s.color : DEFAULT_COLOR);
    // streak
    const streak = s.streak || 0;
    el.streak.hidden = !(s.paired && streak > 0);
    el.streak.textContent = "🔥 " + streak;
    if (s.paired && streak > state.streak && state.streak !== null) {
      if (streak > 1) toast(`🔥 ${streak} days of beeping back!`, 2600);
      el.streak.classList.remove("bump");
      void el.streak.offsetWidth;
      el.streak.classList.add("bump");
    }
    state.streak = streak;
    el.notifyName.textContent = friend();
  }

  function sendProfile() {
    if (socket.connected && state.code) socket.emit("profile", { name: state.name, color: state.color });
  }
  function setName(v) {
    state.name = v.trim().slice(0, 20);
    store.set(LS.name, state.name);
    el.nameInput.value = state.name;
    el.settingsName.value = state.name;
  }
  el.nameInput.addEventListener("change", () => { setName(el.nameInput.value); sendProfile(); });
  el.settingsName.addEventListener("change", () => { setName(el.settingsName.value); sendProfile(); toast("name saved", 900); });

  COLORS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = c;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", "Color " + c);
    b.addEventListener("click", () => {
      state.color = c;
      store.set(LS.color, c);
      renderSwatches();
      sendProfile();
    });
    el.swatches.appendChild(b);
  });
  function renderSwatches() {
    [...el.swatches.children].forEach((b, i) => b.setAttribute("aria-checked", String(COLORS[i] === state.color)));
  }
  renderSwatches();

  // ---------- screens ----------
  function showPairing({ waiting = false, error = "" } = {}) {
    el.pairSheet.hidden = false;
    el.pairChoose.hidden = waiting;
    el.pairWaiting.hidden = !waiting;
    el.nameInput.hidden = waiting;
    el.showLinkBtn.hidden = waiting;
    el.linkForm.hidden = true;
    el.pairError.textContent = error;
    el.bar.hidden = true;
    el.emojiBar.hidden = true;
    el.notifyCard.hidden = true;
  }
  function showRobot() {
    el.pairSheet.hidden = true;
    el.bar.hidden = false;
    el.emojiBar.hidden = false;
    el.codeChip.textContent = state.code;
    setTimeout(() => { el.hint.style.opacity = 0; }, 10000);
    maybeAskNotifications();
  }
  const shareUrl = () => location.origin + "/?code=" + state.code;
  async function copy(text, msg = "copied!") {
    try { await navigator.clipboard.writeText(text); toast(msg, 1200); }
    catch { toast(text, 4000); }
  }

  // ---------- push notifications ----------
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  function urlB64ToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function enableNotifications() {
    if (!pushSupported()) {
      toast(isIOS && !isStandalone() ? "On iPhone: Share → Add to Home Screen first" : "notifications aren't supported here", 3500);
      return;
    }
    if (!state.vapidKey) { toast("server has no push key yet, try again", 2500); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { renderNotify(); toast("notifications are blocked in browser settings", 3000); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(state.vapidKey) });
      socket.emit("push-subscribe", { sub: sub.toJSON(), clientId: state.clientId });
      store.set(LS.notif, "1");
      toast("notifications on 🔔", 1500);
    } catch (err) {
      console.warn("[BeepBack] push subscribe failed", err);
      toast("couldn't turn on notifications", 2500);
    }
    renderNotify();
  }
  async function disableNotifications() {
    let endpoint = null;
    try { const sub = await currentSub(); if (sub) { endpoint = sub.endpoint; await sub.unsubscribe(); } } catch {}
    socket.emit("push-unsubscribe", { endpoint });
    store.set(LS.notif, "0");
    toast("notifications off", 1200);
    renderNotify();
  }
  // Re-send our subscription on every connect (the server may have restarted or the sub rotated).
  async function syncPush() {
    if (store.get(LS.notif) !== "1" || !pushSupported() || Notification.permission !== "granted") return;
    try {
      const sub = await currentSub();
      if (sub) socket.emit("push-subscribe", { sub: sub.toJSON(), clientId: state.clientId });
      else if (state.vapidKey) await enableNotifications();
    } catch {}
  }
  function renderNotify() {
    const on = store.get(LS.notif) === "1" && pushSupported() && Notification.permission === "granted";
    const blocked = pushSupported() && Notification.permission === "denied";
    el.notifyBtn.textContent = on ? "🔕 Turn off notifications" : "🔔 Turn on notifications";
    el.notifyBtn.disabled = blocked;
    el.notifyNote.hidden = !(blocked || (isIOS && !isStandalone()));
    el.notifyNote.textContent = blocked
      ? "Notifications are blocked. Allow them in your browser's site settings."
      : "On iPhone, add BeepBack to your Home Screen to get notifications.";
  }
  el.notifyBtn.addEventListener("click", () => {
    const on = store.get(LS.notif) === "1" && pushSupported() && Notification.permission === "granted";
    on ? disableNotifications() : enableNotifications();
  });
  function maybeAskNotifications() {
    const ask = !IS_WIDGET && pushSupported() && Notification.permission === "default" && !store.get(LS.notifAsked);
    el.notifyCard.hidden = !ask;
  }
  $("notifyYes").addEventListener("click", () => { store.set(LS.notifAsked, "1"); el.notifyCard.hidden = true; enableNotifications(); });
  $("notifyNo").addEventListener("click", () => { store.set(LS.notifAsked, "1"); el.notifyCard.hidden = true; });

  // ---------- socket ----------
  const socket = io({ transports: ["websocket", "polling"] });

  function rememberCode(code) { state.code = code; store.set(LS.code, code); }
  function forgetCode() {
    state.code = null;
    state.paired = false;
    state.streak = 0;
    store.del(LS.code);
    renderPending(null);
  }
  const profilePayload = () => ({ clientId: state.clientId, name: state.name, color: state.color });

  function join(code, { silent = false } = {}) {
    code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    socket.emit("join", { code, ...profilePayload() }, (res) => {
      if (res && res.ok) {
        rememberCode(res.code); // the partner-status event that follows decides the screen
      } else if (res && res.gone) {
        forgetCode();
        renderStatus({ paired: false });
        showPairing({ error: res.error });
      } else if (!silent) {
        showPairing({ error: (res && res.error) || "Could not join" });
      }
    });
  }

  let serverChecked = false;
  socket.on("connect", () => {
    el.offline.hidden = true;
    if (state.code) join(state.code, { silent: true }); // auto-rejoin
    socket.emit("visible", { visible: !document.hidden });
    if (state.asleep) socket.emit("activity", { state: "asleep" });
    // Catch the "old server still running" case.
    setTimeout(() => { if (!serverChecked) warnOldServer(); }, 3000);
  });
  socket.on("disconnect", () => {
    serverChecked = false;
    el.offline.textContent = "reconnecting…";
    el.offline.hidden = false;
  });
  socket.on("hello", ({ version, vapidKey } = {}) => {
    serverChecked = true;
    state.vapidKey = vapidKey || null;
    if (!(version >= NEEDS_SERVER_VERSION)) warnOldServer();
    syncPush();
  });
  function warnOldServer() {
    el.offline.textContent = "server is outdated: restart it (npm start)";
    el.offline.hidden = false;
    console.warn("[BeepBack] server is older than this app; restart it");
  }

  document.addEventListener("visibilitychange", () => {
    if (socket.connected) socket.emit("visible", { visible: !document.hidden });
    if (!document.hidden) { poke(); markSeen(); }
  });

  socket.on("partner-status", (s) => {
    const wasPaired = state.paired;
    const wasOnline = state.partnerOnline;
    if (!wasPaired) state.streak = null; // don't toast the streak we already had on (re)join
    renderStatus(s);
    renderPending(s.pending);
    if (s.paired) {
      showRobot();
      if (!wasPaired) {
        if (!heldExp()) flashExp("happy");
        beep([523, 784, 1046]);
        toast(s.name ? `paired with ${s.name}! say hi 👋` : "paired! say hi 👋");
      } else if (s.online && !wasOnline) toast(`${Friend()} is back ✨`);
    } else {
      el.bigCode.textContent = state.code;
      showPairing({ waiting: true });
    }
  });

  socket.on("partner-unpaired", () => { toast(`${Friend()} unpaired 💔`, 3000); flashExp("sad", 3000); });
  socket.on("you-unpaired", () => {
    if (!state.code) return;
    forgetCode();
    renderStatus({ paired: false });
    el.settingsSheet.hidden = true;
    showPairing();
  });
  socket.on("emoji", ({ e }) => receiveEmoji(e));
  socket.on("nudge", receiveNudge);
  socket.on("hug", receiveHug);

  // ---------- pairing UI ----------
  $("createBtn").addEventListener("click", () => {
    el.pairError.textContent = "";
    setName(el.nameInput.value);
    socket.emit("create", profilePayload(), (res) => {
      if (!res || !res.ok) return showPairing({ error: (res && res.error) || "Could not create" });
      rememberCode(res.code);
      el.bigCode.textContent = res.code;
      showPairing({ waiting: true });
    });
  });
  $("joinForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = el.codeInput.value.trim();
    if (code.length !== 6) { el.pairError.textContent = "Codes are 6 characters"; return; }
    el.pairError.textContent = "";
    setName(el.nameInput.value);
    join(code);
  });
  el.codeInput.addEventListener("input", () => {
    el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  el.showLinkBtn.addEventListener("click", () => {
    el.linkForm.hidden = !el.linkForm.hidden;
    if (!el.linkForm.hidden) el.linkInput.focus();
  });
  el.linkInput.addEventListener("input", () => {
    el.linkInput.value = el.linkInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  el.linkForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const linkCode = el.linkInput.value.trim();
    if (linkCode.length !== 6) { el.pairError.textContent = "Link codes are 6 characters"; return; }
    socket.emit("link-redeem", { linkCode }, (res) => {
      if (!res || !res.ok) { el.pairError.textContent = (res && res.error) || "Couldn't link"; return; }
      // become the same person as the other device, then join their pair
      state.clientId = res.clientId;
      store.set(LS.clientId, res.clientId);
      el.linkForm.hidden = true;
      el.linkInput.value = "";
      el.pairError.textContent = "";
      join(res.code);
      toast("device linked ✓", 1500);
    });
  });
  $("copyCodeBtn").addEventListener("click", () => copy(state.code, "code copied!"));
  $("shareBtn").addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "BeepBack", text: "Beep me back on BeepBack! Code: " + state.code, url: shareUrl() }); } catch {}
    } else copy(shareUrl(), "link copied!");
  });
  $("cancelBtn").addEventListener("click", () => { socket.emit("leave"); forgetCode(); showPairing(); });
  el.codeChip.addEventListener("click", () => copy(shareUrl(), "share link copied!"));

  // ---------- settings ----------
  $("settingsBtn").addEventListener("click", () => { renderNotify(); el.linkPanel.hidden = true; el.settingsSheet.hidden = false; });
  $("closeSettingsBtn").addEventListener("click", () => { el.settingsSheet.hidden = true; });
  el.settingsSheet.addEventListener("click", (ev) => { if (ev.target === el.settingsSheet) el.settingsSheet.hidden = true; });
  el.soundToggle.addEventListener("change", () => { state.sound = el.soundToggle.checked; store.set(LS.sound, state.sound ? "1" : "0"); });
  el.vibeToggle.addEventListener("change", () => { state.vibe = el.vibeToggle.checked; store.set(LS.vibe, state.vibe ? "1" : "0"); });
  el.linkBtn.addEventListener("click", () => {
    socket.emit("link-create", null, (res) => {
      if (!res || !res.ok) { toast((res && res.error) || "couldn't make a link code", 2500); return; }
      el.linkCode.textContent = res.linkCode;
      el.linkExpiry.textContent = `works once, for ${res.expiresInMin} minutes`;
      el.linkPanel.hidden = false;
    });
  });
  $("unpairBtn").addEventListener("click", () => {
    socket.emit("leave");
    forgetCode();
    el.settingsSheet.hidden = true;
    renderStatus({ paired: false });
    showPairing();
  });

  // ---------- PWA install ----------
  let installEvt = null;
  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    installEvt = ev;
    el.installBtn.hidden = false;
  });
  el.installBtn.addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null;
    el.installBtn.hidden = true;
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // ---------- boot ----------
  const urlCode = new URLSearchParams(location.search).get("code");
  if (urlCode) {
    history.replaceState(null, "", "/");
    if (store.get(LS.code) !== urlCode.toUpperCase()) forgetCode();
    state.code = urlCode.toUpperCase();
    el.codeInput.value = state.code;
  } else {
    state.code = store.get(LS.code);
  }
  showPairing();
  // the "connect" handler joins state.code automatically
})();
