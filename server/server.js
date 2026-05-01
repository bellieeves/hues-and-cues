import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../client/dist");

// ─── Palette (must match client's buildWebSafePalette) ────────────────────────
const PALETTE_ROWS = [
  ["FFCCCC","FFDDCC","FFEECC","FFFFCC","EEFFCC","CCFFCC","CCFFDD","CCFFEE","CCFFFF","CCEEFF","CCDDFF","CCCCFF","DDCCFF","EECCFF","FFCCFF","FFCCEE","FFCCDD"],
  ["FF9999","FFB899","FFD899","FFFF99","D8FF99","99FF99","99FFB8","99FFD8","99FFFF","99D8FF","99B8FF","9999FF","B899FF","D899FF","FF99FF","FF99D8","FF99B8"],
  ["FF6666","FF9966","FFCC66","FFFF66","CCFF66","66FF66","66FF99","66FFCC","66FFFF","66CCFF","6699FF","6666FF","9966FF","CC66FF","FF66FF","FF66CC","FF6699"],
  ["FF3333","FF7733","FFBB33","FFFF33","BBFF33","33FF33","33FF77","33FFBB","33FFFF","33BBFF","3377FF","3333FF","7733FF","BB33FF","FF33FF","FF33BB","FF3377"],
  ["FF0000","FF5500","FFAA00","FFFF00","AAFF00","00FF00","00FF55","00FFAA","00FFFF","00AAFF","0055FF","0000FF","5500FF","AA00FF","FF00FF","FF00AA","FF0055"],
  ["CC0000","CC4400","CC8800","CCCC00","88CC00","00CC00","00CC44","00CC88","00CCCC","0088CC","0044CC","0000CC","4400CC","8800CC","CC00CC","CC0088","CC0044"],
  ["990000","993300","996600","999900","669900","009900","009933","009966","009999","006699","003399","000099","330099","660099","990099","990066","990033"],
  ["660000","662200","664400","666600","446600","006600","006622","006644","006666","004466","002266","000066","220066","440066","660066","660044","660022"],
  ["111111","222222","333333","444444","555555","666666","777777","888888","999999","AAAAAA","BBBBBB","CCCCCC","DDDDDD","EEEEEE","FFFFFF","F0F0F0","E0E0E0"],
];

const PALETTE = [];
PALETTE_ROWS.forEach((row, r) => {
  row.forEach((hex, c) => {
    PALETTE.push({ hex: `#${hex}`, id: `${r}-${c}` });
  });
});
const PALETTE_BY_ID = new Map(PALETTE.map(c => [c.id, c]));

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function colorDistance(c1, c2) {
  const a = hexToRgb(c1.hex), b = hexToRgb(c2.hex);
  const dr = (a.r - b.r) / 255, dg = (a.g - b.g) / 255, db = (a.b - b.b) / 255;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function scoreFromDistance(dist) {
  if (dist < 0.08) return 5;
  if (dist < 0.18) return 4;
  if (dist < 0.28) return 3;
  if (dist < 0.40) return 2;
  if (dist < 0.55) return 1;
  return 0;
}

const FORBIDDEN_WORDS = [
  "red","blue","green","yellow","orange","purple","pink","brown","black","white","gray","grey",
  "violet","indigo","cyan","magenta","maroon","navy","teal","lime","aqua","coral","salmon",
  "crimson","scarlet","azure","cobalt","turquoise","amber","beige","ivory","khaki","lavender",
  "mauve","ochre","olive","sienna","tan","umber","vermillion","gold","silver","rose",
];
function containsForbidden(text) {
  const lower = text.toLowerCase();
  for (const w of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) return w;
  }
  return null;
}

// ─── Room state ────────────────────────────────────────────────────────────────
const rooms = new Map();

function newRoom(code) {
  return {
    code,
    players: [],
    sockets: new Map(),
    describerIndex: 0,
    phase: "waiting",
    targetColorId: null,
    clue1: null,
    clue2: null,
    guesses: {},
    clue1Guesses: {}, // snapshot of guesses at the moment clue 2 was submitted
    ready: {},
    round: 1,
  };
}

// "Got the color" threshold — distance < 0.18 → score >= 4.
const CORRECT_SCORE_THRESHOLD = 4;
const CLUE1_BONUS = 3;

function correctGuessersDuringClue1(room) {
  if (!room.targetColorId) return 0;
  const target = PALETTE_BY_ID.get(room.targetColorId);
  let n = 0;
  const describerId = room.players[room.describerIndex]?.id;
  for (const [pid, colorId] of Object.entries(room.guesses)) {
    if (pid === describerId) continue;
    const c = PALETTE_BY_ID.get(colorId);
    if (c && scoreFromDistance(colorDistance(target, c)) >= CORRECT_SCORE_THRESHOLD) n += 1;
  }
  return n;
}

function publicState(room) {
  return {
    phase: room.phase,
    players: room.players,
    describerIndex: room.describerIndex,
    targetColorId: room.phase === "results" ? room.targetColorId : null,
    clue1: room.clue1,
    clue2: room.clue2,
    guesses: room.guesses,
    ready: room.ready,
    round: room.round,
  };
}

// Only the current describer sees targetColorId during a live round.
// The describer also sees a live "correct guesses" tally during phase 1,
// to help decide whether clue 2 is needed.
function stateFor(room, playerId) {
  const base = publicState(room);
  const describer = room.players[room.describerIndex];
  if (describer && describer.id === playerId) {
    if (room.phase !== "results") {
      base.targetColorId = room.targetColorId;
    }
    if (room.phase === "guessing1") {
      base.correctGuessCount = correctGuessersDuringClue1(room);
    }
  }
  return base;
}

function broadcast(room) {
  for (const player of room.players) {
    const ws = room.sockets.get(player.id);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "STATE", state: stateFor(room, player.id) }));
    }
  }
}

function sendError(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "ERROR", message }));
  }
}

// ─── Action handlers ───────────────────────────────────────────────────────────
function handleJoin(ws, msg) {
  const name = (msg.name || "").trim().slice(0, 24);
  const roomCode = (msg.roomCode || "").trim().toUpperCase();
  if (!name || !roomCode) {
    sendError(ws, "Missing name or room code");
    return;
  }

  let room = rooms.get(roomCode);
  if (!room) {
    room = newRoom(roomCode);
    rooms.set(roomCode, room);
  }

  const playerId = randomUUID();
  room.players.push({ id: playerId, name, score: 0 });
  room.sockets.set(playerId, ws);
  ws.playerId = playerId;
  ws.roomCode = roomCode;

  ws.send(JSON.stringify({
    type: "JOINED",
    playerId,
    roomCode,
    state: stateFor(room, playerId),
  }));
  broadcast(room);
}

function handleStartRound(ws, room) {
  const describer = room.players[room.describerIndex];
  if (!describer || describer.id !== ws.playerId) {
    sendError(ws, "Only the describer can start the round");
    return;
  }
  if (room.players.length < 2) {
    sendError(ws, "Need at least 2 players to start");
    return;
  }
  const target = PALETTE[Math.floor(Math.random() * PALETTE.length)];
  room.phase = "clue1";
  room.targetColorId = target.id;
  room.clue1 = null;
  room.clue2 = null;
  room.guesses = {};
  room.clue1Guesses = {};
  room.ready = {};
  room.players = room.players.map(p => ({ ...p, lastPts: undefined, lastViaClue1: false }));
  broadcast(room);
}

function handleClue(ws, room, text, which) {
  const describer = room.players[room.describerIndex];
  if (!describer || describer.id !== ws.playerId) {
    sendError(ws, "Only the describer can submit clues");
    return;
  }
  const expectedPhase = which === 1 ? "clue1" : "guessing1";
  if (room.phase !== expectedPhase) {
    sendError(ws, `Cannot submit clue ${which} now`);
    return;
  }
  const clean = (text || "").trim();
  const minLen = which === 1 ? 5 : 3;
  if (clean.length < minLen) {
    sendError(ws, "Clue is too short");
    return;
  }
  const forbidden = containsForbidden(clean);
  if (forbidden) {
    sendError(ws, `Forbidden word: "${forbidden}"`);
    return;
  }
  if (which === 1) {
    room.clue1 = clean;
    room.phase = "guessing1";
  } else {
    // Snapshot the clue-1 guesses so we can award the early-correct bonus
    // even if a player revises their pick after seeing clue 2.
    room.clue1Guesses = { ...room.guesses };
    room.clue2 = clean;
    room.phase = "guessing2";
  }
  // Fresh round of guessing — clear ready flags so guessers must re-confirm.
  room.ready = {};
  broadcast(room);
}

function handleGuess(ws, room, colorId) {
  if (room.phase !== "guessing1" && room.phase !== "guessing2") {
    sendError(ws, "Cannot guess now");
    return;
  }
  const describer = room.players[room.describerIndex];
  if (describer && describer.id === ws.playerId) {
    sendError(ws, "Describer cannot guess");
    return;
  }
  if (!PALETTE_BY_ID.has(colorId)) {
    sendError(ws, "Invalid color");
    return;
  }
  room.guesses = { ...room.guesses, [ws.playerId]: colorId };
  // Switching pick clears ready — player must confirm again.
  if (room.ready[ws.playerId]) {
    const next = { ...room.ready };
    delete next[ws.playerId];
    room.ready = next;
  }
  broadcast(room);
}

function handleSetReady(ws, room) {
  if (room.phase !== "guessing1" && room.phase !== "guessing2") {
    sendError(ws, "Can only ready up while guessing");
    return;
  }
  const describer = room.players[room.describerIndex];
  if (describer && describer.id === ws.playerId) {
    sendError(ws, "Describer doesn't need to ready up");
    return;
  }
  if (!room.guesses[ws.playerId]) {
    sendError(ws, "Pick a color first");
    return;
  }
  room.ready = { ...room.ready, [ws.playerId]: true };
  broadcast(room);
}

function handleReveal(ws, room) {
  const describer = room.players[room.describerIndex];
  if (!describer || describer.id !== ws.playerId) {
    sendError(ws, "Only the describer can reveal");
    return;
  }
  if (room.phase !== "guessing2") {
    sendError(ws, "Can only reveal after clue 2");
    return;
  }

  const target = PALETTE_BY_ID.get(room.targetColorId);
  const newPlayers = room.players.map((p, i) => {
    if (i === room.describerIndex) return { ...p, lastPts: undefined, lastViaClue1: false };

    // If the player already nailed it after clue 1 (snapshot), award that
    // score plus a bonus — don't penalise them for staying put on clue 2.
    const clue1GuessId = room.clue1Guesses[p.id];
    if (clue1GuessId) {
      const c1 = PALETTE_BY_ID.get(clue1GuessId);
      const score1 = scoreFromDistance(colorDistance(target, c1));
      if (score1 >= CORRECT_SCORE_THRESHOLD) {
        const pts = score1 + CLUE1_BONUS;
        return { ...p, score: (p.score || 0) + pts, lastPts: pts, lastViaClue1: true };
      }
    }

    // Otherwise score the final guess at normal rates.
    const finalGuessId = room.guesses[p.id];
    if (!finalGuessId) return { ...p, lastPts: 0, lastViaClue1: false };
    const cF = PALETTE_BY_ID.get(finalGuessId);
    const pts = scoreFromDistance(colorDistance(target, cF));
    return { ...p, score: (p.score || 0) + pts, lastPts: pts, lastViaClue1: false };
  });

  const guesserPts = newPlayers
    .filter((_, i) => i !== room.describerIndex)
    .map(p => p.lastPts || 0);
  const avg = guesserPts.length ? guesserPts.reduce((a, b) => a + b, 0) / guesserPts.length : 0;
  if (avg >= 2 && newPlayers[room.describerIndex]) {
    const d = newPlayers[room.describerIndex];
    newPlayers[room.describerIndex] = { ...d, score: (d.score || 0) + 3, lastPts: 3 };
  }

  room.players = newPlayers;
  room.phase = "results";
  broadcast(room);
}

function handleNextRound(ws, room) {
  const describer = room.players[room.describerIndex];
  if (!describer || describer.id !== ws.playerId) {
    sendError(ws, "Only the current describer can advance");
    return;
  }
  if (room.phase !== "results") {
    sendError(ws, "Can only advance from results");
    return;
  }
  room.phase = "waiting";
  room.describerIndex = (room.describerIndex + 1) % room.players.length;
  room.targetColorId = null;
  room.clue1 = null;
  room.clue2 = null;
  room.guesses = {};
  room.clue1Guesses = {};
  room.ready = {};
  room.round = (room.round || 1) + 1;
  room.players = room.players.map(p => ({ ...p, lastPts: undefined, lastViaClue1: false }));
  broadcast(room);
}

function handleDisconnect(ws) {
  const { roomCode, playerId } = ws;
  if (!roomCode || !playerId) return;
  const room = rooms.get(roomCode);
  if (!room) return;

  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) return;

  const wasDescriber = idx === room.describerIndex;
  room.players.splice(idx, 1);
  room.sockets.delete(playerId);
  delete room.guesses[playerId];
  delete room.ready[playerId];

  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (idx < room.describerIndex) {
    room.describerIndex -= 1;
  } else if (wasDescriber) {
    room.describerIndex = room.describerIndex % room.players.length;
    if (room.phase !== "waiting" && room.phase !== "results") {
      room.phase = "waiting";
      room.targetColorId = null;
      room.clue1 = null;
      room.clue2 = null;
      room.guesses = {};
      room.clue1Guesses = {};
      room.ready = {};
    }
  }
  broadcast(room);
}

// ─── Static file serving (so one service hosts both client and server) ────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".map":  "application/json",
};

function serveStatic(req, res) {
  if (!fs.existsSync(CLIENT_DIST)) return false;

  const url = (req.url || "/").split("?")[0];
  let filePath = path.join(CLIENT_DIST, url === "/" ? "index.html" : url);
  filePath = path.normalize(filePath);

  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403); res.end(); return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback
    filePath = path.join(CLIENT_DIST, "index.html");
    if (!fs.existsSync(filePath)) return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ─── Server plumbing ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (serveStatic(req, res)) return;
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return sendError(ws, "Invalid JSON"); }

    if (msg.type === "JOIN") {
      handleJoin(ws, msg);
      return;
    }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
    if (!room || !ws.playerId) {
      sendError(ws, "Not in a room");
      return;
    }

    switch (msg.type) {
      case "START_ROUND":  return handleStartRound(ws, room);
      case "SUBMIT_CLUE1": return handleClue(ws, room, msg.text, 1);
      case "SUBMIT_CLUE2": return handleClue(ws, room, msg.text, 2);
      case "SUBMIT_GUESS": return handleGuess(ws, room, msg.colorId);
      case "SET_READY":    return handleSetReady(ws, room);
      case "REVEAL":       return handleReveal(ws, room);
      case "NEXT_ROUND":   return handleNextRound(ws, room);
      default: sendError(ws, `Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", () => handleDisconnect(ws));
});

server.listen(PORT, () => {
  console.log(`Hues & Clues server listening on port ${PORT}`);
  if (fs.existsSync(CLIENT_DIST)) {
    console.log(`Serving client from ${CLIENT_DIST}`);
  } else {
    console.log("No client/dist found — running in API-only mode (use Vite dev server for the client).");
  }
});
