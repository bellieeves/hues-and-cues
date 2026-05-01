import { useState, useEffect, useRef, useCallback } from "react";

// ─── Server URL ──────────────────────────────────────────────────────────────
// Same-origin in both dev (via Vite proxy on /ws) and production (served by
// the Node server). Override with VITE_SERVER_URL for cross-host dev setups.
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

// ─── Web-Safe Palette ────────────────────────────────────────────────────────
function buildWebSafePalette() {
  const colors = [];
  // Rows: light to dark, Cols: red → orange → yellow → green → cyan → blue → purple → magenta → back
  const rows = [
    // pinks/pastels
    ["FFCCCC","FFDDCC","FFEECC","FFFFCC","EEFFCC","CCFFCC","CCFFDD","CCFFEE","CCFFFF","CCEEFF","CCDDFF","CCCCFF","DDCCFF","EECCFF","FFCCFF","FFCCEE","FFCCDD"],
    // light
    ["FF9999","FFB899","FFD899","FFFF99","D8FF99","99FF99","99FFB8","99FFD8","99FFFF","99D8FF","99B8FF","9999FF","B899FF","D899FF","FF99FF","FF99D8","FF99B8"],
    // medium light
    ["FF6666","FF9966","FFCC66","FFFF66","CCFF66","66FF66","66FF99","66FFCC","66FFFF","66CCFF","6699FF","6666FF","9966FF","CC66FF","FF66FF","FF66CC","FF6699"],
    // medium
    ["FF3333","FF7733","FFBB33","FFFF33","BBFF33","33FF33","33FF77","33FFBB","33FFFF","33BBFF","3377FF","3333FF","7733FF","BB33FF","FF33FF","FF33BB","FF3377"],
    // pure saturated
    ["FF0000","FF5500","FFAA00","FFFF00","AAFF00","00FF00","00FF55","00FFAA","00FFFF","00AAFF","0055FF","0000FF","5500FF","AA00FF","FF00FF","FF00AA","FF0055"],
    // medium dark
    ["CC0000","CC4400","CC8800","CCCC00","88CC00","00CC00","00CC44","00CC88","00CCCC","0088CC","0044CC","0000CC","4400CC","8800CC","CC00CC","CC0088","CC0044"],
    // dark
    ["990000","993300","996600","999900","669900","009900","009933","009966","009999","006699","003399","000099","330099","660099","990099","990066","990033"],
    // very dark
    ["660000","662200","664400","666600","446600","006600","006622","006644","006666","004466","002266","000066","220066","440066","660066","660044","660022"],
    // grays
    ["111111","222222","333333","444444","555555","666666","777777","888888","999999","AAAAAA","BBBBBB","CCCCCC","DDDDDD","EEEEEE","FFFFFF","F0F0F0","E0E0E0"],
  ];

  rows.forEach((row, r) => {
    row.forEach((hex, c) => {
      colors.push({ hex: `#${hex}`, id: `${r}-${c}` });
    });
  });
  return colors;
}

function hexToRgb(hex) {
  const h = hex.replace("#","");
  return {
    r: parseInt(h.slice(0,2),16),
    g: parseInt(h.slice(2,4),16),
    b: parseInt(h.slice(4,6),16),
  };
}

function colorDistance(c1, c2) {
  const r1 = hexToRgb(c1.hex), r2 = hexToRgb(c2.hex);
  const dr = (r1.r - r2.r)/255, dg = (r1.g - r2.g)/255, db = (r1.b - r2.b)/255;
  return Math.sqrt(dr*dr + dg*dg + db*db);
}

function scoreFromDistance(dist) {
  if (dist < 0.08) return 5;
  if (dist < 0.18) return 4;
  if (dist < 0.28) return 3;
  if (dist < 0.40) return 2;
  if (dist < 0.55) return 1;
  return 0;
}

const PALETTE = buildWebSafePalette();
const COLS = 17;

const ESL_STARTERS = [
  "It's the color of…",
  "It looks like…",
  "It's darker than…",
  "It's lighter than…",
  "It's not as bright as…",
  "It reminds me of…",
  "Kind of like…",
  "Similar to…",
  "Slightly more ___ than…",
  "Imagine a…",
];

const FORBIDDEN_WORDS = [
  "red","blue","green","yellow","orange","purple","pink","brown","black","white","gray","grey",
  "violet","indigo","cyan","magenta","maroon","navy","teal","lime","aqua","coral","salmon",
  "crimson","scarlet","azure","cobalt","turquoise","amber","beige","ivory","khaki","lavender",
  "mauve","ochre","olive","sienna","tan","umber","vermillion","gold","silver","rose",
];

function containsForbidden(text) {
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.find(w => {
    const re = new RegExp(`\\b${w}\\b`);
    return re.test(lower);
  });
}

// ─── WebSocket multiplayer hook ───────────────────────────────────────────────
function useMultiplayer(roomId, myName) {
  const [gameState, setGameState] = useState(null);
  const [myId, setMyId] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!roomId || !myName) return;

    let cancelled = false;
    const ws = new WebSocket(SERVER_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (cancelled) return;
      setConnected(true);
      ws.send(JSON.stringify({ type: "JOIN", name: myName, roomCode: roomId }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "JOINED") {
        setMyId(msg.playerId);
        setGameState(msg.state);
      } else if (msg.type === "STATE") {
        setGameState(msg.state);
      } else if (msg.type === "ERROR") {
        setError(msg.message);
        setTimeout(() => setError(null), 4000);
      }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [roomId, myName]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  return { gameState, myId, connected, error, send };
}

// ─── Components ───────────────────────────────────────────────────────────────

function ColorSwatch({ color, size = 80 }) {
  return (
    <div style={{
      width: size, height: size,
      background: color.hex,
      borderRadius: 12,
      boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
      border: "3px solid rgba(255,255,255,0.2)",
    }} />
  );
}

function PaletteGrid({ onSelect, guesses = {}, targetId = null, showTarget = false, myId, phase, compact = false }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${COLS}, 1fr)`,
      gap: compact ? 2 : 3,
      padding: compact ? 8 : 12,
      background: "rgba(255,255,255,0.05)",
      borderRadius: 16,
      border: "1px solid rgba(255,255,255,0.1)",
    }}>
      {PALETTE.map((color) => {
        const isTarget = showTarget && color.id === targetId;
        const myGuess = guesses[myId];
        const isMyGuess = myGuess === color.id;
        const othersGuessed = Object.entries(guesses).filter(([pid, cid]) => pid !== myId && cid === color.id);
        
        return (
          <div key={color.id} style={{ position: "relative" }}>
            <div
              onClick={() => onSelect && onSelect(color)}
              style={{
                width: "100%",
                paddingBottom: "100%",
                background: color.hex,
                borderRadius: compact ? 2 : 4,
                cursor: onSelect ? "pointer" : "default",
                border: isTarget ? "3px solid #fff" : isMyGuess ? "3px solid #FFD700" : "1px solid rgba(0,0,0,0.15)",
                boxSizing: "border-box",
                transition: "transform 0.1s, border 0.1s",
                transform: isMyGuess || isTarget ? "scale(1.15)" : "scale(1)",
                zIndex: isMyGuess || isTarget ? 2 : 1,
                position: "relative",
              }}
            />
            {isTarget && (
              <div style={{
                position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                fontSize: 12, zIndex: 10,
              }}>🎯</div>
            )}
            {othersGuessed.length > 0 && (
              <div style={{
                position: "absolute", top: -6, right: -4,
                background: "#FF6B6B", borderRadius: "50%",
                width: 14, height: 14,
                fontSize: 9, color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, zIndex: 10,
              }}>{othersGuessed.length}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ESLPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: "linear-gradient(135deg, #667eea, #764ba2)",
          border: "none", borderRadius: 10, padding: "8px 16px",
          color: "#fff", fontFamily: "inherit", fontSize: 13,
          cursor: "pointer", fontWeight: 600,
          boxShadow: "0 2px 10px rgba(102,126,234,0.5)",
        }}
      >
        📚 ESL Phrases
      </button>
      {open && (
        <div style={{
          position: "absolute", top: 44, left: 0, zIndex: 100,
          background: "rgba(20,20,35,0.97)",
          border: "1px solid rgba(102,126,234,0.4)",
          borderRadius: 14, padding: 16, width: 280,
          backdropFilter: "blur(20px)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}>
          <div style={{ color: "#a0a0c0", fontSize: 11, marginBottom: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Sentence Starters</div>
          {ESL_STARTERS.map((s, i) => (
            <div key={i} style={{
              color: "#e0e0ff", fontSize: 13, padding: "6px 10px",
              borderRadius: 6, marginBottom: 3,
              background: "rgba(102,126,234,0.15)",
              fontStyle: "italic",
            }}>{s}</div>
          ))}
          <div style={{ marginTop: 12, color: "#a0a0c0", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Useful Modifiers</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            {["slightly", "very", "kind of", "almost", "a bit", "quite", "really", "rather", "barely", "deeply"].map(w => (
              <span key={w} style={{
                background: "rgba(255,107,107,0.2)", border: "1px solid rgba(255,107,107,0.3)",
                color: "#ff9a9a", borderRadius: 6, padding: "3px 8px", fontSize: 12,
              }}>{w}</span>
            ))}
          </div>
          <div style={{ marginTop: 12, color: "#a0a0c0", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>❌ Forbidden Color Words</div>
          <div style={{ color: "#ff6b6b", fontSize: 11, marginTop: 4, lineHeight: 1.6 }}>
            {FORBIDDEN_WORDS.slice(0, 20).join(", ")}…
          </div>
        </div>
      )}
    </div>
  );
}

function Timer({ seconds, onEnd }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const t = setInterval(() => setLeft(l => {
      if (l <= 1) { clearInterval(t); onEnd && onEnd(); return 0; }
      return l - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [seconds]);
  const pct = (left / seconds) * 100;
  const color = pct > 50 ? "#4ade80" : pct > 25 ? "#fbbf24" : "#f87171";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{
        width: 120, height: 8, background: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%",
          background: color, borderRadius: 4,
          transition: "width 1s linear, background 0.5s",
        }} />
      </div>
      <span style={{ color, fontWeight: 700, fontSize: 16, minWidth: 28 }}>{left}s</span>
    </div>
  );
}

// ─── Main Game ────────────────────────────────────────────────────────────────

const styles = {
  app: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #0a0a1a 0%, #0f0f2e 50%, #0a0a1a 100%)",
    fontFamily: "'Georgia', 'Times New Roman', serif",
    color: "#e8e8f8",
    padding: 20,
  },
  title: {
    fontFamily: "'Georgia', serif",
    fontSize: 38,
    fontWeight: 400,
    letterSpacing: -1,
    background: "linear-gradient(90deg, #a78bfa, #f472b6, #fb923c)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    margin: 0,
  },
  card: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 20,
    padding: 24,
    backdropFilter: "blur(10px)",
  },
  input: {
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 10,
    padding: "10px 14px",
    color: "#fff",
    fontFamily: "inherit",
    fontSize: 15,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  btn: (variant = "primary") => ({
    background: variant === "primary"
      ? "linear-gradient(135deg, #a78bfa, #7c3aed)"
      : "rgba(255,255,255,0.08)",
    border: variant === "primary" ? "none" : "1px solid rgba(255,255,255,0.15)",
    borderRadius: 10,
    padding: "10px 22px",
    color: "#fff",
    fontFamily: "inherit",
    fontSize: 14,
    cursor: "pointer",
    fontWeight: 600,
    letterSpacing: 0.3,
    transition: "opacity 0.15s, transform 0.1s",
  }),
  label: {
    color: "#8888aa",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 6,
    display: "block",
  },
};

// ─── Lobby ────────────────────────────────────────────────────────────────────

function Lobby({ onJoin }) {
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [mode, setMode] = useState(null); // "create" | "join"

  const randomRoom = () => Math.random().toString(36).slice(2, 7).toUpperCase();

  return (
    <div style={{ maxWidth: 460, margin: "60px auto" }}>
      <div style={{ textAlign: "center", marginBottom: 40 }}>
        <h1 style={styles.title}>Hues & Clues</h1>
        <p style={{ color: "#6666aa", fontSize: 15, marginTop: 8 }}>
          An ESL color description game
        </p>
      </div>
      <div style={styles.card}>
        <label style={styles.label}>Your Name</label>
        <input
          style={{ ...styles.input, marginBottom: 20 }}
          placeholder="e.g. Maria"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        {!mode && (
          <div style={{ display: "flex", gap: 12 }}>
            <button style={{ ...styles.btn("primary"), flex: 1 }} onClick={() => { setMode("create"); setRoom(randomRoom()); }}>
              🎨 Create Room
            </button>
            <button style={{ ...styles.btn("secondary"), flex: 1 }} onClick={() => setMode("join")}>
              🚪 Join Room
            </button>
          </div>
        )}
        {mode === "create" && (
          <div>
            <label style={styles.label}>Room Code (share with friends)</label>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <input style={{ ...styles.input, flex: 1, letterSpacing: 4, fontWeight: 700 }}
                value={room} readOnly />
              <button style={styles.btn("secondary")} onClick={() => setRoom(randomRoom())}>🔀</button>
            </div>
            <div style={{
              background: "rgba(102,126,234,0.1)", border: "1px solid rgba(102,126,234,0.2)",
              borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13, color: "#a0a0cc",
            }}>
              💡 Open this page in multiple tabs and use the same room code to play together!
            </div>
            <button style={{ ...styles.btn("primary"), width: "100%" }}
              onClick={() => name.trim() && room && onJoin(name.trim(), room, true)}>
              Create & Enter
            </button>
          </div>
        )}
        {mode === "join" && (
          <div>
            <label style={styles.label}>Room Code</label>
            <input style={{ ...styles.input, marginBottom: 16, letterSpacing: 4, fontWeight: 700 }}
              placeholder="e.g. AB3XY"
              value={room}
              onChange={e => setRoom(e.target.value.toUpperCase())}
            />
            <button style={{ ...styles.btn("primary"), width: "100%" }}
              onClick={() => name.trim() && room.trim() && onJoin(name.trim(), room.trim(), false)}>
              Join Room
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Game Room ────────────────────────────────────────────────────────────────

function GameRoom({ myId, roomId, gameState, send, error }) {
  const [clue1, setClue1] = useState("");
  const [clue2, setClue2] = useState("");
  const [forbidden, setForbidden] = useState(null);
  const [selectedColor, setSelectedColor] = useState(null);

  const amDescriber = gameState?.describerIndex !== undefined
    && gameState?.players?.[gameState.describerIndex]?.id === myId;
  const targetColor = gameState?.targetColorId
    ? PALETTE.find(c => c.id === gameState.targetColorId)
    : null;
  const isReady = !!gameState?.ready?.[myId];

  // Reset local UI between rounds / phases
  useEffect(() => {
    if (gameState?.phase === "waiting" || gameState?.phase === "clue1") {
      setClue1(""); setClue2(""); setForbidden(null); setSelectedColor(null);
    }
  }, [gameState?.phase, gameState?.round]);

  const startRound = () => send({ type: "START_ROUND" });

  const submitClue1 = () => {
    const word = containsForbidden(clue1);
    if (word) { setForbidden(word); return; }
    if (clue1.trim().length < 5) return;
    send({ type: "SUBMIT_CLUE1", text: clue1.trim() });
    setForbidden(null);
  };

  const submitClue2 = () => {
    const word = containsForbidden(clue2);
    if (word) { setForbidden(word); return; }
    if (clue2.trim().length < 3) return;
    send({ type: "SUBMIT_CLUE2", text: clue2.trim() });
    setForbidden(null);
  };

  const submitGuess = (color) => {
    if (!color) return;
    setSelectedColor(color);
    send({ type: "SUBMIT_GUESS", colorId: color.id });
  };

  const markReady = () => send({ type: "SET_READY" });
  const revealResults = () => send({ type: "REVEAL" });
  const nextRound = () => send({ type: "NEXT_ROUND" });

  if (!gameState) return <div style={{ textAlign: "center", padding: 60, color: "#6666aa" }}>Connecting…</div>;

  const phase = gameState.phase;
  const describer = gameState.players?.[gameState.describerIndex];
  const guessCount = Object.keys(gameState.guesses || {}).length;
  const readyCount = Object.keys(gameState.ready || {}).length;
  const nonDescriberCount = Math.max(1, (gameState.players?.length || 1) - 1);
  const allReady = readyCount >= nonDescriberCount;

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ ...styles.title, fontSize: 26, margin: 0 }}>Hues & Clues</h1>
          <div style={{ color: "#6666aa", fontSize: 12, marginTop: 2 }}>
            Room: <span style={{ color: "#a78bfa", fontWeight: 700, letterSpacing: 2 }}>{roomId}</span>
            {" · "}Round {gameState.round || 1}
          </div>
        </div>
        <ESLPanel />
      </div>

      {error && (
        <div style={{
          background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.4)",
          color: "#fca5a5", padding: 10, borderRadius: 10, marginBottom: 16, fontSize: 13,
        }}>⚠ {error}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 20 }}>
        {/* Sidebar: players */}
        <div style={styles.card}>
          <div style={styles.label}>Players</div>
          {gameState.players?.map((p, i) => (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>
                  {i === gameState.describerIndex ? "🎨" : "🧩"}
                </span>
                <span style={{
                  fontSize: 14,
                  color: p.id === myId ? "#a78bfa" : "#e8e8f8",
                  fontWeight: p.id === myId ? 700 : 400,
                }}>
                  {p.name}
                  {p.id === myId ? " (you)" : ""}
                </span>
                {(phase === "guessing1" || phase === "guessing2") && i !== gameState.describerIndex && (
                  <span style={{ fontSize: 11 }}>
                    {gameState.ready?.[p.id] ? "✅" : gameState.guesses?.[p.id] ? "🤔" : "⏳"}
                  </span>
                )}
              </div>
              <span style={{
                fontWeight: 700, fontSize: 15,
                color: p.lastPts ? "#4ade80" : "#6666aa",
              }}>
                {p.score || 0}
                {p.lastPts ? <span style={{ fontSize: 11, color: "#4ade80" }}> +{p.lastPts}</span> : null}
              </span>
            </div>
          ))}
          {phase === "waiting" && amDescriber && (
            <button
              style={{ ...styles.btn("primary"), width: "100%", marginTop: 16 }}
              onClick={startRound}
            >
              {gameState.round > 1 ? "Next Round →" : "Start Game →"}
            </button>
          )}
          {phase === "waiting" && !amDescriber && (
            <div style={{ color: "#6666aa", fontSize: 13, marginTop: 12, textAlign: "center" }}>
              Waiting for<br /><strong style={{ color: "#e8e8f8" }}>{describer?.name}</strong><br />to start…
            </div>
          )}
        </div>

        {/* Main area */}
        <div>
          {/* Clue display */}
          {(gameState.clue1 || gameState.clue2) && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              {gameState.clue1 && (
                <div style={{ marginBottom: gameState.clue2 ? 8 : 0 }}>
                  <span style={styles.label}>Clue 1</span>
                  <div style={{ fontSize: 18, color: "#f0f0ff", fontStyle: "italic" }}>
                    "{gameState.clue1}"
                  </div>
                </div>
              )}
              {gameState.clue2 && (
                <div>
                  <span style={{ ...styles.label, marginTop: 8 }}>Clue 2</span>
                  <div style={{ fontSize: 18, color: "#fbbf24", fontStyle: "italic" }}>
                    "{gameState.clue2}"
                  </div>
                </div>
              )}
            </div>
          )}

          {/* DESCRIBER: clue input */}
          {amDescriber && phase === "clue1" && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <div>
                  <span style={styles.label}>Your Secret Color</span>
                  {targetColor && <ColorSwatch color={targetColor} size={64} />}
                  <div style={{ color: "#8888aa", fontSize: 11, marginTop: 4 }}>{targetColor?.hex}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: "#8888aa", fontSize: 13, lineHeight: 1.6 }}>
                    🎯 Describe this color <strong style={{ color: "#f0f0ff" }}>without</strong> saying any color names!<br />
                    Use comparisons, objects, feelings, memories…
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <span style={styles.label}>Full Palette — for reference</span>
                <PaletteGrid compact={true} myId={myId} guesses={{}} />
              </div>
              <label style={styles.label}>Your First Clue</label>
              <input
                style={{ ...styles.input, marginBottom: 6 }}
                placeholder='e.g. "like the ocean at noon in Spain"'
                value={clue1}
                onChange={e => { setClue1(e.target.value); setForbidden(null); }}
                onKeyDown={e => e.key === "Enter" && submitClue1()}
              />
              {forbidden && (
                <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>
                  ❌ Forbidden word detected: <strong>"{forbidden}"</strong>. Try another description!
                </div>
              )}
              {!forbidden && clue1.trim().length > 0 && clue1.trim().length < 5 && (
                <div style={{ color: "#8888aa", fontSize: 12, marginBottom: 8 }}>
                  Need at least 5 characters ({clue1.trim().length}/5)
                </div>
              )}
              <button
                style={{ ...styles.btn("primary"), opacity: clue1.trim().length < 5 ? 0.55 : 1 }}
                onClick={submitClue1}
                disabled={clue1.trim().length < 5}
              >
                Send Clue 1 →
              </button>
            </div>
          )}

          {/* DESCRIBER: waiting for guesses, then clue 2 */}
          {amDescriber && phase === "guessing1" && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
                <ColorSwatch color={targetColor} size={52} />
                <div>
                  <div style={{ color: "#4ade80", fontSize: 14 }}>
                    ✅ Clue 1 sent! Players are guessing… ({guessCount}/{nonDescriberCount} guessed)
                  </div>
                </div>
              </div>
              <label style={styles.label}>Your Second Clue (more specific)</label>
              <input
                style={{ ...styles.input, marginBottom: 6 }}
                placeholder='e.g. "warmer than you think, slightly brownish"'
                value={clue2}
                onChange={e => { setClue2(e.target.value); setForbidden(null); }}
                onKeyDown={e => e.key === "Enter" && submitClue2()}
              />
              {forbidden && (
                <div style={{ color: "#f87171", fontSize: 13, marginBottom: 8 }}>
                  ❌ Forbidden word: <strong>"{forbidden}"</strong>
                </div>
              )}
              {!forbidden && clue2.trim().length > 0 && clue2.trim().length < 3 && (
                <div style={{ color: "#8888aa", fontSize: 12, marginBottom: 8 }}>
                  Need at least 3 characters ({clue2.trim().length}/3)
                </div>
              )}
              <button
                style={{ ...styles.btn("primary"), opacity: clue2.trim().length < 3 ? 0.55 : 1 }}
                onClick={submitClue2}
                disabled={clue2.trim().length < 3}
              >
                Send Clue 2 →
              </button>
            </div>
          )}

          {/* DESCRIBER: waiting for second round guesses */}
          {amDescriber && phase === "guessing2" && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              <div style={{ color: "#4ade80", marginBottom: 12 }}>
                ✅ Clue 2 sent! ({readyCount}/{nonDescriberCount} ready)
              </div>
              <button
                style={{ ...styles.btn("primary"), opacity: allReady ? 1 : 0.55 }}
                onClick={revealResults}
                disabled={!allReady}
              >
                🎯 {allReady ? "Reveal Results!" : "Waiting for everyone to be ready…"}
              </button>
            </div>
          )}

          {/* GUESSER: palette */}
          {!amDescriber && (phase === "guessing1" || phase === "guessing2") && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div>
                  <span style={styles.label}>Click your best guess!</span>
                  {selectedColor && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                      <ColorSwatch color={selectedColor} size={32} />
                      <span style={{ color: "#a78bfa", fontSize: 13 }}>Selected ✓</span>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ color: "#6666aa", fontSize: 13 }}>
                    {Object.keys(gameState.ready || {}).length}/{nonDescriberCount} ready
                  </div>
                  {selectedColor && !isReady && (
                    <button
                      style={{
                        ...styles.btn("primary"),
                        background: "linear-gradient(135deg, #4ade80, #22c55e)",
                        padding: "8px 18px",
                      }}
                      onClick={markReady}
                    >
                      ✅ Ready!
                    </button>
                  )}
                  {isReady && (
                    <div style={{
                      background: "rgba(74,222,128,0.15)", border: "1px solid rgba(74,222,128,0.4)",
                      borderRadius: 8, padding: "6px 14px", color: "#4ade80", fontSize: 13, fontWeight: 600,
                    }}>
                      ✅ You're ready!
                    </div>
                  )}
                </div>
              </div>
              <PaletteGrid
                onSelect={submitGuess}
                guesses={gameState.guesses}
                myId={myId}
                phase={phase}
              />
            </div>
          )}

          {/* WAITING: describer is typing */}
          {!amDescriber && phase === "clue1" && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              <div style={{ textAlign: "center", padding: "20px 0 16px" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>✍️</div>
                <div style={{ color: "#a0a0cc", fontSize: 16 }}>
                  <strong style={{ color: "#e8e8f8" }}>{describer?.name}</strong> is thinking of a clue…
                </div>
                <div style={{ color: "#6666aa", fontSize: 13, marginTop: 6 }}>
                  Browse the palette while you wait!
                </div>
              </div>
              <PaletteGrid compact={true} myId={myId} guesses={{}} />
            </div>
          )}

          {/* RESULTS */}
          {phase === "results" && (
            <div style={{ ...styles.card, marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
                <div>
                  <span style={styles.label}>The Answer Was</span>
                  {targetColor && <ColorSwatch color={targetColor} size={72} />}
                  <div style={{ color: "#8888aa", fontSize: 12, marginTop: 4 }}>
                    {targetColor?.hex}
                  </div>
                </div>
                <div style={{ flex: 1 }}>
                  <PaletteGrid
                    guesses={gameState.guesses}
                    targetId={gameState.targetColorId}
                    showTarget={true}
                    myId={myId}
                    phase="results"
                  />
                </div>
              </div>

              {/* Scores */}
              <div style={{ marginBottom: 16 }}>
                {gameState.players?.map((p, i) => (
                  <div key={p.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 12px", borderRadius: 8,
                    background: p.id === myId ? "rgba(167,139,250,0.1)" : "transparent",
                    marginBottom: 4,
                  }}>
                    <span style={{ color: p.id === myId ? "#a78bfa" : "#e8e8f8" }}>
                      {i === gameState.describerIndex ? "🎨" : "🧩"} {p.name}
                    </span>
                    <span>
                      {p.lastPts !== undefined && (
                        <span style={{
                          color: p.lastPts >= 3 ? "#4ade80" : p.lastPts >= 1 ? "#fbbf24" : "#f87171",
                          fontWeight: 700, marginRight: 12,
                        }}>
                          {p.lastPts >= 3 ? "🎯 +" : p.lastPts >= 1 ? "⭐ +" : "💨 +"}{p.lastPts} pts
                        </span>
                      )}
                      <span style={{ color: "#8888aa" }}>Total: </span>
                      <span style={{ fontWeight: 700 }}>{p.score}</span>
                    </span>
                  </div>
                ))}
              </div>

              {amDescriber || gameState.players?.[gameState.describerIndex]?.id === myId ? (
                <button style={styles.btn("primary")} onClick={nextRound}>
                  Next Round (
                  {gameState.players?.[(gameState.describerIndex + 1) % gameState.players.length]?.name}'s turn)
                  →
                </button>
              ) : (
                <div style={{ color: "#6666aa", fontSize: 13 }}>
                  Waiting for {describer?.name} to start next round…
                </div>
              )}
            </div>
          )}

          {/* Waiting to start */}
          {phase === "waiting" && !amDescriber && gameState.round === 1 && (
            <div style={{ ...styles.card, textAlign: "center", padding: 40 }}>
              <div style={{ fontSize: 42, marginBottom: 12 }}>🎨</div>
              <div style={{ color: "#a0a0cc", fontSize: 16, marginBottom: 8 }}>
                Waiting for <strong style={{ color: "#e8e8f8" }}>{describer?.name}</strong> to start the game
              </div>
              <div style={{ color: "#6666aa", fontSize: 13 }}>
                {gameState.players?.length} player{gameState.players?.length !== 1 ? "s" : ""} in room
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [joined, setJoined] = useState(null); // { name, roomId }
  const { gameState, myId, connected, error, send } = useMultiplayer(
    joined?.roomId,
    joined?.name,
  );

  if (!joined) {
    return (
      <div style={styles.app}>
        <Lobby onJoin={(name, roomId) => setJoined({ name, roomId })} />
      </div>
    );
  }

  if (!connected || !myId) {
    return (
      <div style={styles.app}>
        <div style={{ textAlign: "center", padding: 60, color: "#6666aa" }}>
          {connected ? "Joining room…" : "Connecting to server…"}
          {error && (
            <div style={{ color: "#f87171", marginTop: 16, fontSize: 13 }}>⚠ {error}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <GameRoom
        myId={myId}
        roomId={joined.roomId}
        gameState={gameState}
        send={send}
        error={error}
      />
    </div>
  );
}