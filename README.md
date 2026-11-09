# 🤖 BeepBack (BB): a tiny robot for two

> *Send a beep, get one back.*

A black screen with a cute robot face: soft white eyes, blush, a little smile.
Two people pair their robots with a **6‑character code**. When one taps an emoji,
the other person's robot **makes that face and keeps holding the emoji until they beep back**.
If the friend isn't looking, they get a **push notification**. Install it to your phone or desktop
and it runs like a little **widget app**.

<!-- Add a screenshot here: docs/screenshot.png -->

---

## ✨ Features

| Feature | What happens |
|---|---|
| **Pair with a code** | One person taps *Create a code* and gets something like `VC4TE3`. The other types it in or opens the share link `/?code=VC4TE3`. |
| **Pairs last** | Pairs are saved on the server (`data/state.json`) and survive restarts. A pair is only forgotten after **30 days** with no activity. Each person is in one pair at a time. |
| **Emojis stay until answered** | A received emoji sits in a speech bubble and the robot keeps that face until you send an emoji back. While it's holding one, the robot doesn't fall asleep. |
| **Seen 👀** | The sender's bubble says *waiting for reply…* and switches to *seen 👀* once the friend opens the app and looks at it. Sending more before a reply shows ×2, ×3. |
| **A unique face for every emoji** | See the table below. |
| **Push notifications** | "💀 Arjun sent you 💀", "Arjun is thinking of you 💭", "Arjun sent you a hug 🤗". They're only sent when the friend's app is closed or in the background. |
| **Nicknames** | Type your name when pairing (or in ⚙ Settings). The app says *"Arjun is here ✨"*, *"paired with Arjun!"* and so on. |
| **Robot color** | Pick one of 6 colors. **Your friend's robot wears your color** (blush, hearts, tongue), and yours wears theirs. |
| **🔥 Streak** | Counts the days in a row that someone beeped back (replied). It shows as 🔥 N in the top bar and resets if a day is missed. |
| **Tap = nudge, hold = hug** | Tap the face to send *"thinking of you"* 💭 (blush plus a double blink for them). **Hold for about 1 s** to grow a heart and send a 🤗 hug: a heart burst, love eyes and a long buzz on their side. |
| **Alive when idle** | Random blinks, eyes follow your mouse or finger, eyes wander when idle. It falls asleep (*z z z*) after 60 s unless it's holding an emoji. |
| **Partner status** | 🟢 here · 🟠 sleeping · ⚫ away |
| **Sounds + vibration** | A small beep melody per emoji (Web Audio, no files) and haptics on Android. Both can be turned off in Settings. |
| **Installable widget (PWA)** | "Add to Home Screen" on phones, or install as a small window on desktop. The home‑screen name is **BB**. |
| **Safety** | Allowlisted emojis and colors only, names sanitized (20 chars), max 2 people per room, max 10 000 rooms, ~10 events/sec per user, unambiguous codes (no `0/O/1/I`), clientIds never shared with the partner. |

### 😶 Faces

| Emoji | Robot face |
|---|---|
| ❤️ | ♥ ♥ beating heart eyes, big smile, rosy blush |
| 😊 | ^ ^ happy arcs, smile |
| 😂 | > < squeezed eyes, open laughing mouth, tears of joy flying, giggle shake |
| 😮 | O O big round eyes, little "o" mouth |
| 😢 | droopy eyes, frown, falling tear |
| 😡 | slanted angry brows, flat mouth, red blush, shake |
| 😴 | closed eyes, *z z z* |
| 👋 | wink, smile, head tilt |
| 🎉 | ★ ★ twinkling star eyes, open smile, bounce, confetti |
| 💀 | X X eyes, tongue out, faded blush, woozy tilt |

---

## 🧠 How it works

```
 Riya                             Server (Node + Socket.IO)                     Arjun
 ────                             ─────────────────────────                     ─────
 [Create a code] ── create ───▶  room "VC4TE3"  (saved to data/state.json)
                                                                 ◀── join VC4TE3 ── [Join]
 ◀──────────── partner-status {paired, name, color, streak} ─────────────────▶

 tap 😂 ───────── emoji ──────▶  pending = {from Riya, 😂}
 "waiting…" ◀─ partner-status ─┤├─ emoji + partner-status ─▶ > < laugh face, held in bubble
                                └─ Arjun away? → Web Push ──▶ 🔔 "Riya sent you 😂"
 "seen 👀" ◀── partner-status ◀── seen ──────────────────────── Arjun opens the app
                                                                ◀── emoji 💀 ── Arjun beeps back
 💀 held ◀──────────────── pending = {from Arjun, 💀}, streak 🔥+1 ──────────▶ "waiting…"
```

- **Server state** lives in memory and is written to `data/state.json` (debounced, atomic rename):
  - `rooms`: `code → { clients, pending, streak, lastActive }`
  - `profiles`: `clientId → { name, color, sub (push subscription), lastSeen }`
- `pending` is the last **unanswered emoji**. A reply from the other person replaces it and bumps the streak.
- Each browser makes a random **clientId** (in `localStorage`), so a refreshed tab gets its place back.
- **Push** uses the Web Push standard with VAPID keys. The keys are generated once into `data/vapid.json`, or come from env. The service worker (`sw.js`) shows the notification, and tapping it opens or focuses the app.
- The **client** is plain HTML/CSS/JS with no build step. The face is CSS shapes sized with container units (`cqw`). Each expression is a `data-exp="…"` attribute styled in `style.css`.

## 🧱 Tech stack

- **Node.js 18+**, **Express**, **Socket.IO**, **web-push**
- Vanilla **HTML / CSS / JavaScript**
- **PWA**: `manifest.webmanifest` + service worker `sw.js` (offline shell + push)
- Web APIs: Push, Notifications, Web Audio, Vibration, Web Share, Clipboard

## 📁 Project structure

```
smtgU/   (project folder; the app is called BeepBack)
├─ server.js               # rooms, pairing, held emoji, seen, streaks, push, persistence, limits
├─ package.json
├─ render.yaml             # one-click Render deploy (with a disk for data/)
├─ data/                   # created at runtime: state.json + vapid.json (git-ignored, keep private)
├─ public/
│  ├─ index.html           # face, bubble, hug heart, bars, pairing + settings sheets
│  ├─ style.css            # face + every expression, bubble, animations, layout
│  ├─ app.js               # expressions, held emojis, nudge/hug, names/colors, push, socket client
│  ├─ manifest.webmanifest # makes it installable ("BB")
│  ├─ sw.js                # app-shell cache + push notifications
│  └─ icons/               # icon.svg + PNGs (192, 512, maskable)
└─ tools/make-icons.js     # regenerates the PNG icons (no dependencies)
```

## 🔌 Socket events

| Direction | Event | Payload | Meaning |
|---|---|---|---|
| client → server | `create` | `{ clientId, name, color }` → ack `{ ok, code }` | make a new pair |
| client → server | `join` | `{ code, clientId, name, color }` → ack `{ ok }` / `{ ok:false, error, gone }` | join or rejoin |
| client → server | `profile` | `{ name, color }` | change name or color |
| client → server | `emoji` | `{ e }` | send an emoji (allowlisted); becomes the held emoji |
| client → server | `seen` | none | "I've looked at the held emoji" |
| client → server | `nudge` / `hug` | none | tap / hold on the face |
| client → server | `activity` | `{ state: "awake" \| "asleep" }` | sleep status |
| client → server | `visible` | `{ visible }` | app on screen? (decides whether to push) |
| client → server | `push-subscribe` / `push-unsubscribe` | `{ sub }` / none | Web Push subscription |
| client → server | `leave` | none | unpair |
| server → client | `hello` | `{ version, vapidKey }` | on connect; the app warns if the server is too old |
| server → client | `partner-status` | `{ paired, online, state, name, color, streak, pending: { mine, e, count, seen } \| null }` | everything about the pair |
| server → client | `emoji` / `nudge` / `hug` | `{ e, at }` / `{ at }` | relayed from the partner (plays the animation) |
| server → client | `partner-unpaired` / `replaced` | none | partner left / opened in another tab |

---

## 🚀 Run it locally

```bash
cd smtgU
npm install
npm start            # → http://localhost:3000
# or: npm run dev    # auto-restarts when server.js changes (recommended while developing)
```

> ⚠️ **After changing `server.js` (or pulling an update), restart the server** (Ctrl+C, then `npm start`). Node doesn't reload code by itself. If the server is older than the app, the app shows *"server is outdated: restart it"*. Pairs are saved, so restarting is safe.

**Two people on one computer:** use a normal window plus an incognito window (they need separate `localStorage`).
**Phone on the same Wi‑Fi:** open `http://<your-PC-IP>:3000` (from `ipconfig`). Allow Node through Windows Firewall if needed. Push notifications need HTTPS on phones, so test those after deploying (they work on `localhost` on desktop).

### Environment variables

| Variable | Default | What for |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | where pairs + push keys are saved (point it at a persistent disk in production) |
| `STREAK_TZ` | server's zone | time zone for streak days, e.g. `Asia/Kolkata` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | auto-generated | fixed push keys (otherwise generated once into `DATA_DIR/vapid.json`) |
| `VAPID_SUBJECT` | `mailto:beepback@example.com` | contact for push services. **Set this to your own email or site** |
| `MAX_ROOMS` | `10000` | cap on active pairs |

## 🔔 Notifications

- Tap **Turn on** on the card that appears after pairing, or ⚙ Settings → **Turn on notifications**.
- **Android / desktop Chrome, Edge, Firefox:** works in the browser or the installed app.
- **iPhone / iPad (iOS 16.4+):** first **Share → Add to Home Screen**, open BeepBack from the home screen, then turn notifications on. Safari tabs can't receive web push.
- If you lose `data/vapid.json` (or change the keys), existing subscriptions stop working. Each person just turns notifications on again.

## 📲 Install as a widget

PWA install needs **HTTPS** (or `localhost`):
- **Android (Chrome):** ⋮ → *Add to Home screen / Install app*
- **iPhone (Safari):** Share → *Add to Home Screen*
- **Windows / Mac (Chrome or Edge):** the install icon in the address bar, or ⚙ → *Install as widget*. Resize the window small and it stays a little robot.

## 🌍 Put it online

Your friend on another network needs the app hosted with HTTPS. You need a Node host with a **persistent disk** so pairs and push keys survive restarts:

| Host | How |
|---|---|
| **Render** | Push this folder to GitHub → Render → **New → Blueprint** → pick the repo. `render.yaml` sets up the service plus a 1 GB disk at `/var/data` (disks need the paid *Starter* plan). Set `VAPID_SUBJECT` to your email. |
| **Railway** | Deploy from GitHub, add a **Volume** mounted at `/data`, and set `DATA_DIR=/data`. |
| **Fly.io** | `fly launch`, `fly volumes create bb_data`, mount it at `/data` in `fly.toml`, set `DATA_DIR=/data`, then `fly deploy`. |

> On free plans without a disk, the app still works, but pairs and push keys reset whenever the server restarts or sleeps.

---

## 🎨 Customize

- **Emojis:** edit `EMOJIS` in `public/app.js` **and** `ALLOWED_EMOJIS` in `server.js`.
- **New face:** add `.face[data-exp="myface"] …` rules in `style.css` and use `exp: "myface"` in `EMOJIS`.
- **Colors:** `COLORS` in `app.js` **and** `ALLOWED_COLORS` in `server.js`. Other UI colors are CSS variables at the top of `style.css`.
- **Timers:** `SLEEP_AFTER_MS`, `HUG_HOLD_MS` (app.js) · `PAIR_TTL_MS` (server.js).
- **Icons:** edit `tools/make-icons.js` + `public/icons/icon.svg`, then `npm run icons`.
- **Cache version:** after changing files, bump `CACHE` in `sw.js` (e.g. `beepback-v7`) so installed apps update cleanly.

## 💡 Ideas for later

- Tap the bubble to clear an emoji with an "I saw it" ✓ without replying
- Robot accessories (antenna, bow, glasses)
- Tiny doodles or voice beeps sent between robots
- A real native home‑screen widget (wrap the app with Capacitor)
- A desktop always‑on‑top mini window (Tauri or Electron)

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE` on start | That port is taken. Run with a different `PORT`. |
| Emojis vanish / robot doesn't keep the face | The server is running old code. Restart it (Ctrl+C → `npm start`), or use `npm run dev`. |
| No notifications | Check they're on in ⚙ Settings and allowed in the browser's site settings. On iPhone, the app must be opened from the Home Screen. Push needs HTTPS (or desktop `localhost`). |
| Two tabs in the same browser don't pair | They share `localStorage`, so they count as one person. Use normal + incognito, or two devices. |
| Install button never shows | You need HTTPS or `localhost`. Check DevTools → Application → Manifest. |
| No sound | Browsers block audio until you tap the page once. Also check ⚙ → Sounds. |
| Old version keeps showing | Bump `CACHE` in `sw.js`, or DevTools → Application → Service Workers → *Update*. |
| "No robot with that code" | Typo, or the pair was unused for 30 days. Create a new one. |
