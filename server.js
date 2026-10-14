const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const LIST = require("./countries");

const nz = t => t.replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
const ctr = [...new Set(LIST.map(t => nz(t.replace(/\s+/g, ""))))];
const MS = 10000, MAXP = 12;
const rooms = new Map();

const alive = r => r.players.map((_, i) => i).filter(i => !r.out.includes(i));
function nxt(r, i) { for (let k = 1; k <= r.players.length; k++) { const j = (i + k) % r.players.length; if (!r.out.includes(j)) return j } return i }
const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

function pen(r, i, msg) {
  r.q[i]++; r.word = "";
  if (r.q[i] >= 4) r.out.push(i);
  const rem = alive(r);
  if (r.out.includes(i)) msg += " " + r.players[i].name + " خرج من الجولة.";
  if (rem.length <= 2) { r.phase = "over"; r.flash = msg + " الفائزون: " + rem.map(k => r.players[k].name).join(" و ") }
  else r.flash = msg + " الدور على اللي بعده والكلمة تبدأ من جديد.";
  r.turn = nxt(r, i);
}
function arm(r) {
  clearTimeout(r.timer);
  if (r.phase !== "play") return;
  r.turnEnd = Date.now() + MS;
  r.timer = setTimeout(() => {
    pen(r, r.turn, "⏰ انتهى وقت " + r.players[r.turn].name + " (10 ثواني) — أخد ربعًا.");
    commit(r);
  }, MS);
}
function view(r, p) {
  return {
    t: "state", me: r.players.indexOf(p),
    left: r.phase === "play" ? Math.max(0, r.turnEnd - Date.now()) : 0,
    s: {
      code: r.code, phase: r.phase, round: r.round, turn: r.turn, word: r.word, flash: r.flash,
      exact: r.phase === "play" && ctr.includes(r.word), isHost: r.host === p.id,
      players: r.players.map((x, i) => ({ name: x.name, q: r.q[i] || 0, out: r.out.includes(i), online: !!x.ws, host: x.id === r.host }))
    }
  };
}
function broadcast(r) {
  r.last = Date.now();
  for (const p of r.players) if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(view(r, p)));
}
function commit(r) { arm(r); broadcast(r) }
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
function newCode() { let c; do { c = String(1000 + Math.floor(Math.random() * 9000)) } while (rooms.has(c)); return c }

function bind(ws, r, p) { p.ws = ws; ws.room = r; ws.pid = p.id }

function handle(ws, m) {
  const id = clean(m.id, 40);
  if (m.t === "hello") {
    const r = rooms.get(String(m.code)), p = r && r.players.find(x => x.id === id);
    if (!p) return send(ws, { t: "none" });
    bind(ws, r, p); return broadcast(r);
  }
  if (m.t === "create") {
    const name = clean(m.name, 20); if (!name || !id) return send(ws, { t: "err", msg: "اكتب اسمك الأول" });
    const r = { code: newCode(), host: id, phase: "lobby", players: [], q: [], out: [], round: 1, turn: 0, word: "", flash: "", turnEnd: 0, timer: null, last: Date.now() };
    const p = { id, name, ws: null }; r.players.push(p); rooms.set(r.code, r); bind(ws, r, p); return broadcast(r);
  }
  if (m.t === "join") {
    const name = clean(m.name, 20), r = rooms.get(String(m.code || "").trim());
    if (!name || !id) return send(ws, { t: "err", msg: "اكتب اسمك وكود الغرفة" });
    if (!r) return send(ws, { t: "err", msg: "الكود ده مش موجود" });
    let p = r.players.find(x => x.id === id);
    if (!p) {
      if (r.phase !== "lobby") return send(ws, { t: "err", msg: "اللعبة دي بدأت بالفعل" });
      if (r.players.length >= MAXP) return send(ws, { t: "err", msg: "الغرفة مليانة (12 لاعب)" });
      p = { id, name, ws: null }; r.players.push(p);
    }
    bind(ws, r, p); return broadcast(r);
  }
  const r = ws.room; if (!r) return;
  const i = r.players.findIndex(x => x.id === ws.pid); if (i < 0) return;
  if (m.t === "start" || m.t === "newround") {
    if (r.host !== ws.pid || r.players.length < 2) return;
    if (m.t === "start" ? r.phase !== "lobby" : r.phase !== "over") return;
    if (m.t === "newround") r.round++;
    Object.assign(r, { phase: "play", q: r.players.map(() => 0), out: [], turn: 0, word: "", flash: "" });
    return commit(r);
  }
  if (r.phase !== "play") {
    if (m.t === "leave" && r.phase === "lobby") {
      r.players.splice(i, 1); ws.room = null;
      if (!r.players.length) { rooms.delete(r.code); return }
      if (r.host === ws.pid) r.host = r.players[0].id;
      broadcast(r);
    }
    return;
  }
  if (m.t === "pick") {
    if (i !== r.turn || typeof m.ch !== "string" || m.ch.length !== 1) return;
    const n = r.word + nz(m.ch);
    if (!ctr.some(c => c.startsWith(n))) pen(r, i, "❌ " + r.players[i].name + " كتب «" + m.ch + "» والحروف «" + n + "» مش بداية أي دولة — غلط! أخد ربعًا.");
    else { r.word = n; r.turn = nxt(r, i); r.flash = "" }
    return commit(r);
  }
  if (m.t === "finish") {
    if (!ctr.includes(r.word)) return;
    pen(r, r.turn, "✅ اكتملت دولة «" + r.word + "»؛ " + r.players[r.turn].name + " أخذ ربعًا.");
    return commit(r);
  }
  if (m.t === "leave") { const p = r.players[i]; p.ws = null; ws.room = null; broadcast(r) }
}

const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.end("ok"); return }
  const f = path.join(__dirname, "public", req.url === "/" ? "index.html" : path.basename(req.url.split("?")[0]));
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found") }
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "text/plain" }); res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on("connection", ws => {
  ws.alive = true; ws.on("pong", () => ws.alive = true);
  ws.on("message", raw => { let m; try { m = JSON.parse(raw) } catch { return } if (m && typeof m === "object") handle(ws, m) });
  ws.on("close", () => {
    const r = ws.room; if (!r) return;
    const p = r.players.find(x => x.id === ws.pid);
    if (p && p.ws === ws) { p.ws = null; broadcast(r) }
  });
});
setInterval(() => { wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping() }) }, 30000);
setInterval(() => { // تنظيف الغرف الفاضية
  for (const [c, r] of rooms) if (Date.now() - r.last > 3 * 3600e3 && !r.players.some(p => p.ws)) { clearTimeout(r.timer); rooms.delete(c) }
}, 600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Country Letters on :" + PORT));
