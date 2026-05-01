# Hues & Clues — Multiplayer ESL Color-Guessing Game

A real-time multiplayer color description game for ESL classrooms. The
describer sees a secret color and gives clues without using color words;
everyone else picks the matching swatch from a 153-color web-safe grid.

```
.
├── server/          Node.js + ws WebSocket server (authoritative state)
├── client/          Vite + React frontend
├── package.json     Root orchestrator (Railway/Nixpacks build target)
├── nixpacks.toml    Railway build config
└── Procfile         Heroku-style start hint (also used by some hosts)
```

## Local development

You need **two terminals**.

### 1. Server (port 8080)

```bash
cd server
npm install
npm start
```

### 2. Client (port 5173, with Vite WS proxy → :8080)

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/ws` to the Node
server, so no env vars are required and the same code path is used in dev
and production.

> Want to play across phones / tablets on the same Wi-Fi? Vite already binds
> to `0.0.0.0`, so just open `http://<your-LAN-IP>:5173` on each device.

## Deploying to Railway

The repo is set up to deploy as a **single Railway service**. Railway runs
the root `nixpacks.toml`, which:

1. Installs deps in `server/` and `client/`
2. Builds the client (`client/dist/`)
3. Starts the Node server, which serves both the WebSocket *and* the static
   client from the same origin

### Steps

1. Push this repo to GitHub.
2. In Railway, create a **New Project → Deploy from GitHub repo**.
3. Pick the repo. Railway auto-detects Nixpacks and runs the build.
4. Once it's live, click **Generate Domain** to get a public URL like
   `https://your-app.up.railway.app`.
5. Open the URL on as many devices as you like and share the room code.

That's it. No environment variables required. The client connects to
`wss://<your-domain>/ws` automatically because it derives the URL from
`window.location`.

> Optional: set `PORT` if you want to override the default 8080 (Railway
> sets this automatically — leave it alone).

## Game flow

1. Describer sees a secret color and types **Clue 1** — color words are
   forbidden (server rejects them).
2. Guessers click their best guess on the palette, then click **Ready**.
3. Describer types **Clue 2** (more specific). Submitting clue 2 clears
   everyone's ready flag so they can revise.
4. Guessers refine their pick and click Ready again.
5. Once everyone is ready, the describer hits **Reveal** — points are
   awarded by RGB distance from the target. The describer earns 3 points
   if guessers averaged ≥ 2 pts.
6. Describer role rotates each round.

## Architecture notes

- **Authoritative server.** Scoring, target selection, forbidden-word
  validation, and ready-up gating all happen server-side. The client is a
  thin renderer.
- **Per-player state slicing.** Only the current describer receives
  `targetColorId` while a round is live; other players see `null` until
  the results phase.
- **Wire protocol** (JSON over WebSocket on `/ws`):
  - Client → server: `JOIN`, `START_ROUND`, `SUBMIT_CLUE1`, `SUBMIT_CLUE2`,
    `SUBMIT_GUESS`, `SET_READY`, `REVEAL`, `NEXT_ROUND`
  - Server → client: `JOINED`, `STATE`, `ERROR`
- **Disconnects.** Players are removed from the room on socket close. If
  the describer leaves mid-round, the round resets and the next player
  takes over.
- **Switching guesses.** Picking a different swatch automatically clears
  that player's ready flag — they have to confirm the new pick.
