# 🚀 Publishing Canoe Arena — Free Online Playtesting Guide

This guide walks you through hosting **Canoe Arena** online for free so you can send
friends a link and start a match. Everything here uses services with a free tier —
no credit card required.

**How the game is hosted:**

```
 friend's browser ─┐
 your browser ─────┼──▶ Netlify (static page, loads instantly, FREE)
                   │         │
                   │         │ wss:// (WebSocket)
                   ▼         ▼
              Render.com (Node game server, FREE tier)
```

- **Netlify** hosts the page (the "client" — all the graphics and UI).
- **Render** hosts the game server (the authoritative simulation all players
  connect to).
- **UptimeRobot** (optional) pings the server every 5 minutes so the free Render
  instance never falls asleep.

The repo is already pushed to GitHub (`scottramos09/canoe-battler`, private) —
the steps below connect the two hosting services to it.

---

## Step 0 — Prerequisites (already done ✅)

- [x] Code is on GitHub at `github.com/scottramos09/canoe-battler`
- [x] `render.yaml` (server blueprint) and `netlify.toml` (client build) are in the repo
- [x] The client auto-detects the server: empty config = same-origin, injected
      config = remote host (verified locally)

You only need accounts on **render.com** and **app.netlify.com** — sign in with
GitHub on both (one click, free).

---

## Step 1 — Deploy the game server on Render (5 minutes)

1. Go to **https://dashboard.render.com** → **New +** → **Blueprint**.
2. Connect your GitHub account (Render shows a list of your repos).
3. Pick **`canoe-battler`**. Render reads `render.yaml` automatically.
4. Confirm the one service it proposes:
   - Name: `canoe-arena-server`
   - Build: `npm install --omit=dev`
   - Start: `node server/server.js`
   - Plan: **Free** (512 MB RAM — plenty)
5. Click **Apply** and wait 2–4 minutes for the first build.

**Find your server URL:** Dashboard → `canoe-arena-server` → the URL shown at the
top looks like `https://canoe-arena-server.onrender.com`. **Write it down** — you
need it for the next step.

> ⚠️ **Free-tier behavior:** the server **falls asleep after ~15 minutes with no
> connections** and takes 30–60 s to wake on the next visitor. The game's client
> auto-retries the connection, so players just see "Connecting to the lagoon…" for
> a bit, then the game appears. **Step 4 (UptimeRobot) eliminates this entirely.**

---

## Step 2 — Deploy the client on Netlify (5 minutes)

1. Go to **https://app.netlify.com** → **Add new site** → **Import an existing project**.
2. Pick **GitHub** → the **`canoe-battler`** repo.
3. Netlify auto-reads `netlify.toml`:
   - Build command: `node scripts/build.js`
   - Publish directory: `public`
4. **Before deploying**, set the environment variable that points the page at
   your Render server:
   - **Site configuration → Environment variables → Add a variable**
   - Key: `CANOE_SERVER`
   - Value: `canoe-arena-server.onrender.com` *(the host from Step 1 — no `https://`, no `/`)*
5. Click **Deploy canoe-battler**. Wait ~1 minute.

**Your game link** is now `https://<site-name>.netlify.app` (rename the site under
**Site configuration → Change site name** to something like `canoe-arena`).

---

## Step 3 — Smoke-test the deployment (2 minutes)

1. Open your Netlify link in **two separate browser windows** (or a normal +
   incognito window).
2. In both: log in — `test` / `test` (or type a new name to auto-create a profile).
3. **Window A (the host):** click **CREATE LOBBY**. The host gets the
   GAME SETTINGS panel (mode, map, bots, difficulty) and the START MATCH button.
4. **Window B (the friend):** click **JOIN LOBBY**. Their name appears in the
   crew list in Window A.
5. Host: pick a map (try **CANNON COVE**), set bot count, click **⚓ START MATCH**.
6. Both windows count down and play. That's it — the pipeline works.

> If you see "Connecting to the lagoon…" for a while, the Render server is cold
> starting (Step 1 note). Wait up to ~60 s; the game appears on its own.

---

## Step 4 — Keep the server awake (2 minutes, recommended)

Free Render instances sleep when idle, which makes friends wait ~1 minute on the
first connect. A free uptime pinger fixes this:

1. Go to **https://uptimerobot.com** → sign up (free).
2. **+ New monitor** → type: **HTTP(s)**.
3. URL: `https://canoe-arena-server.onrender.com/` (your Render URL with a trailing `/`).
4. Interval: **5 minutes**. Save.

UptimeRobot's free plan pings every 5 minutes, which keeps the Render instance
warm — friends connect instantly, all day.

---

## Step 5 — Send the link and start a match

Text your friends:

> **Canoe Arena** 🛶 — https://canoe-arena.netlify.app
> Log in as `test` / `test` (or make up any name + password — it creates your
> profile). I'll host: I click CREATE LOBBY, you click JOIN LOBBY, then I hit
> START MATCH. WASD steer, mouse aim, LMB fire, RMB special, Shift boost, Space jump.

**The play session flow:**

| Who | What |
|---|---|
| You (host) | Open link → log in → **CREATE LOBBY** |
| Friends | Open link → log in → **JOIN LOBBY** |
| You | Set MAP (Box Lagoon / Cannon Cove), MODE (FFA / KOTH), BOTS (fill empty seats — up to 8 total), difficulty |
| You | **⚓ START MATCH** — everyone plays |

After a match everyone returns to the lobby and you start again. Bots fill any
empty slots so even 2 players get a full battle.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Connecting to the lagoon…" forever | Render server is asleep/waking (≤1 min) or crashed. Check Render dashboard → Logs. Visit the Render URL directly in a browser — if it shows the game, the server is up and the client config is wrong. |
| Page loads, then console shows `WebSocket connection to 'wss://…' failed` | `CANOE_SERVER` env on Netlify is missing/mistyped (host only — no `https://`, no port, no path). |
| Friend clicks JOIN LOBBY and sees nobody | They're on a different server than you (different Netlify URL, or you're testing on localhost). Everyone must use **the same link**, and you (host) must have clicked CREATE first — the first human in the server is always the host. |
| Two different friend groups collide in one lobby | The free setup is **one shared lobby** per server instance. For two simultaneous groups, deploy a second Render blueprint instance + second Netlify site (same repo, different `CANOE_SERVER`). |
| Someone got stuck in a ghost lobby | Reopen the link in a fresh tab and JOIN again (the game self-heals: last-human-disconnect resets the lobby). Nuclear option: `POST https://<render-host>/admin/reset` (enabled via `ALLOW_ADMIN=1`, already in `render.yaml`) — clears everything. |
| Bots too easy/hard | Host: GAME SETTINGS → BOT DIFFICULTY (LOW / MEDIUM / HIGH). |
| Server restarted mid-match (deploy/patch) | The client reconnects automatically and rejoins as a fresh lobby; click CREATE again. |

## Free-tier limits (what you're getting)

| Service | Free allowance | Reality for playtesting |
|---|---|---|
| **Netlify** | 100 GB bandwidth / 300 build-min per month | The whole page is ~2 MB; hundreds of sessions fit |
| **Render** | 750 instance-hours / month, sleeps when idle | One always-on (pinged) server ≈ 720 h/month — covers it; a second instance won't |
| **UptimeRobot** | 50 monitors at 5-min intervals | Uses 1 monitor |

No databases, no auth server, no paid add-ons — profiles are stored in each
player's own browser (localStorage), which is why a made-up username works
without signup.

## Alternative (quickest possible, one link, no Netlify)

The Render server also serves the page itself. You can skip Steps 2–3 entirely and
just send friends the **Render URL** from Step 1. Trade-off: when the server is
asleep, the *page itself* takes 30–60 s to load (vs. Netlify where the page loads
instantly and only the connection waits). Fine for casual tests; use the Netlify
split for the best experience.
