'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { attach } = require('./wsserver');
const PROMPTS = require('./prompts');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');

// ---------------------------------------------------------------- constants
const STEPS = 32;      // 2 bars of 16ths
const LEAD_ROWS = 12;  // scale degrees available to the lead
const BASS_ROWS = 7;
const SCALES = ['minorPent', 'majorPent', 'dorian', 'minor', 'major', 'blues'];
// Instrument counts, mirroring public/audio.js. The preset test round-trips a
// song through this server and would fail loudly if these drifted apart.
const LEAD_INSTRUMENTS = 9;
const BASS_INSTRUMENTS = 5;
const KITS = 4;
const MAX_PLAYERS = 12;
const LISTEN_MAX = 26000;   // hard cap per song in the listening phase
const LISTEN_MIN = 9000;    // floor, so a song is never yanked away instantly
const RESULT_AUTO = 45000;  // host idle -> advance anyway
const JAM_VOTE_TIME = 25000; // "is it done?" window between jam turns

// ---------------------------------------------------------------- utilities
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const now = () => Date.now();

function intIn(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
}
function numIn(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
}
function bits(arr, len) {
  const out = new Array(len).fill(0);
  if (Array.isArray(arr)) for (let i = 0; i < len; i++) out[i] = arr[i] ? 1 : 0;
  return out;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Songs arrive from untrusted clients, so force every field into range. One bad
// payload should not be able to wedge everyone else's audio engine.
function sanitizeSong(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const d = s.drums && typeof s.drums === 'object' ? s.drums : {};
  const rawLead = Array.isArray(s.lead) ? s.lead : [];
  const rawBass = Array.isArray(s.bass) ? s.bass : [];
  const lead = [];
  const bass = [];
  for (let i = 0; i < STEPS; i++) {
    lead.push(bits(rawLead[i], LEAD_ROWS));
    bass.push(intIn(rawBass[i], -1, BASS_ROWS - 1, -1));
  }
  return {
    title: String(s.title == null ? '' : s.title).slice(0, 40),
    tempo: intIn(s.tempo, 60, 170, 110),
    root: intIn(s.root, 0, 11, 0),
    scale: SCALES.indexOf(s.scale) >= 0 ? s.scale : 'minorPent',
    swing: numIn(s.swing, 0, 0.6, 0),
    kit: intIn(s.kit, 0, KITS - 1, 0),
    drums: {
      kick: bits(d.kick, STEPS),
      snare: bits(d.snare, STEPS),
      hat: bits(d.hat, STEPS),
      clap: bits(d.clap, STEPS),
    },
    bass,
    lead,
    leadWave: intIn(s.leadWave, 0, LEAD_INSTRUMENTS - 1, 0),
    bassWave: intIn(s.bassWave, 0, BASS_INSTRUMENTS - 1, 0),
    cutoff: numIn(s.cutoff, 0, 1, 0.7),
    delay: s.delay ? 1 : 0,
  };
}

function songIsEmpty(song) {
  if (!song) return true;
  const d = song.drums;
  if (d.kick.indexOf(1) >= 0 || d.snare.indexOf(1) >= 0) return false;
  if (d.hat.indexOf(1) >= 0 || d.clap.indexOf(1) >= 0) return false;
  for (let i = 0; i < song.bass.length; i++) if (song.bass[i] >= 0) return false;
  for (let i = 0; i < song.lead.length; i++) if (song.lead[i].indexOf(1) >= 0) return false;
  return true;
}

// ---------------------------------------------------------------- room model
const rooms = new Map();
let nextId = 1;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function blankSong() {
  return sanitizeSong({});
}

function createRoom() {
  const room = {
    code: makeCode(),
    players: new Map(),
    hostId: null,
    phase: 'lobby',
    mode: 'clash',        // 'clash' = everyone writes their own; 'jam' = one shared song
    settings: { rounds: 3, composeTime: 120, turns: 5 },
    round: 0,
    prompt: '',
    deadline: 0,
    order: [],
    playIndex: -1,
    ratings: new Map(),   // voterId -> 1..5, for the song playing right now
    roundScores: new Map(),
    usedPrompts: [],
    emptyAt: now(),

    // Jam mode: one song passed from player to player, a turn at a time.
    jamSong: null,
    turn: 0,
    composerId: null,
    composerOrder: [],
    doneVotes: new Set(),
  };
  rooms.set(room.code, room);
  return room;
}

function alive(room) {
  const out = [];
  for (const p of room.players.values()) if (p.connected) out.push(p);
  return out;
}

function pickHost(room) {
  const live = alive(room);
  room.hostId = live.length ? live[0].id : null;
}

function pickPrompt(room) {
  if (room.usedPrompts.length >= PROMPTS.length) room.usedPrompts = [];
  let p;
  do { p = PROMPTS[Math.floor(Math.random() * PROMPTS.length)]; }
  while (room.usedPrompts.indexOf(p) >= 0);
  room.usedPrompts.push(p);
  return p;
}

// ---------------------------------------------------------------- broadcast
function playerView(p) {
  return {
    id: p.id,
    name: p.name,
    hue: p.hue,
    score: p.score,
    connected: p.connected,
    submitted: !!p.submitted,
  };
}

function stateFor(room, viewerId) {
  const players = [];
  for (const p of room.players.values()) players.push(playerView(p));

  const base = {
    t: 'state',
    now: now(),
    room: room.code,
    phase: room.phase,
    hostId: room.hostId,
    youAreHost: viewerId === room.hostId,
    deadline: room.deadline,
    round: room.round,
    rounds: room.settings.rounds,
    composeTime: room.settings.composeTime,
    mode: room.mode,
    turns: room.settings.turns,
    prompt: room.prompt,
    players,
  };

  if (room.phase === 'jamturn' || room.phase === 'jamvote' || room.phase === 'jamdone') {
    const composer = room.composerId ? room.players.get(room.composerId) : null;
    base.jam = {
      turn: room.turn,
      turns: room.settings.turns,
      composerId: room.composerId,
      composerName: composer ? composer.name : '',
      composerHue: composer ? composer.hue : 0,
      youAreComposer: !!room.composerId && room.composerId === viewerId,
      song: room.jamSong || blankSong(),
      doneCount: room.doneVotes.size,
      voterCount: alive(room).length,
      yourDone: room.doneVotes.has(viewerId),
      doneNames: [...room.doneVotes]
        .map((id) => (room.players.get(id) || {}).name)
        .filter(Boolean),
    };
  }

  if (room.phase === 'listen') {
    const authorId = room.order[room.playIndex];
    const author = authorId ? room.players.get(authorId) : null;
    if (author) {
      base.nowPlaying = {
        index: room.playIndex,
        total: room.order.length,
        authorId,
        authorName: author.name,
        authorHue: author.hue,
        title: (author.song && author.song.title) || '',
        song: author.song || blankSong(),
      };
      base.yourRating = room.ratings.get(viewerId) || 0;
      base.ratedCount = room.ratings.size;
      base.ratersNeeded = alive(room).filter((p) => p.id !== authorId).length;
      base.isYourSong = authorId === viewerId;
    }
  }

  if (room.phase === 'results' || room.phase === 'final') {
    const board = [];
    for (const p of room.players.values()) {
      const v = playerView(p);
      v.roundScore = room.roundScores.get(p.id) || 0;
      v.title = (p.song && p.song.title) || '';
      v.song = p.song || null;
      board.push(v);
    }
    board.sort((a, b) =>
      room.phase === 'final' ? b.score - a.score : b.roundScore - a.roundScore
    );
    base.board = board;
    base.isFinal = room.phase === 'final';
  }

  return base;
}

function send(sock, obj) {
  if (!sock) return;
  try { sock.send(JSON.stringify(obj)); } catch (e) { /* socket already gone */ }
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected) send(p.sock, stateFor(room, p.id));
  }
}

// ---------------------------------------------------------------- phase flow
function toLobby(room) {
  room.phase = 'lobby';
  room.round = 0;
  room.prompt = '';
  room.deadline = 0;
  room.order = [];
  room.playIndex = -1;
  room.ratings.clear();
  room.roundScores.clear();
  room.jamSong = null;
  room.turn = 0;
  room.composerId = null;
  room.composerOrder = [];
  room.doneVotes.clear();
  for (const p of room.players.values()) {
    p.score = 0;
    p.song = null;
    p.submitted = false;
  }
}

function startRound(room) {
  room.round += 1;
  room.prompt = pickPrompt(room);
  room.phase = 'countdown';
  room.deadline = now() + 5000;
  room.ratings.clear();
  room.roundScores.clear();
  room.order = [];
  room.playIndex = -1;
  for (const p of room.players.values()) {
    p.song = blankSong();
    p.submitted = false;
  }
  broadcast(room);
}

function startCompose(room) {
  room.phase = 'compose';
  room.deadline = now() + room.settings.composeTime * 1000;
  broadcast(room);
}

function songDuration(song) {
  // Room for three loops of the 2-bar pattern, kept inside sane bounds.
  const loop = (60 / song.tempo) * 8; // 32 sixteenths = 8 beats
  return clamp(loop * 3 * 1000 + 3500, LISTEN_MIN, LISTEN_MAX);
}

function commitRatings(room) {
  if (room.playIndex < 0 || room.playIndex >= room.order.length) return;
  const author = room.players.get(room.order[room.playIndex]);
  if (!author) return;
  const values = [...room.ratings.values()];
  // Average star rating scaled to 0-100 so scores read like a percentage.
  // No raters (solo game, or everyone left) scores a neutral 3 stars.
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 3;
  const points = Math.round(avg * 20);
  author.score += points;
  room.roundScores.set(author.id, points);
}

function startResults(room) {
  const last = room.round >= room.settings.rounds;
  room.phase = last ? 'final' : 'results';
  room.deadline = now() + RESULT_AUTO;
  broadcast(room);
}

function nextSong(room) {
  commitRatings(room); // bank the votes for the song that just finished
  room.playIndex += 1;
  room.ratings.clear();

  while (room.playIndex < room.order.length && !room.players.get(room.order[room.playIndex])) {
    room.playIndex += 1; // author disconnected between songs
  }
  if (room.playIndex >= room.order.length) return startResults(room);

  const author = room.players.get(room.order[room.playIndex]);
  room.deadline = now() + songDuration(author.song);
  broadcast(room);
}

function startListen(room) {
  const entrants = alive(room).filter((p) => !songIsEmpty(p.song));
  if (entrants.length === 0) {
    // Nobody placed a single note. Skip straight to the round summary.
    room.order = [];
    room.playIndex = -1;
    return startResults(room);
  }
  room.order = shuffle(entrants.map((p) => p.id));
  room.playIndex = -1;
  room.phase = 'listen';
  nextSong(room);
}

function advanceFromResults(room) {
  if (room.phase === 'final') {
    toLobby(room);
    broadcast(room);
    return;
  }
  startRound(room);
}

// ------------------------------------------------------------- jam mode
// One shared song. Each turn a single player composes while everyone else
// watches the notes land live. Between turns the room votes on whether it is
// finished; the turn cap stops a room that can never agree.

function startJam(room) {
  room.round = 1;
  room.prompt = pickPrompt(room);
  room.jamSong = blankSong();
  room.turn = 0;
  room.composerId = null;
  room.composerOrder = alive(room).map((p) => p.id);
  room.doneVotes.clear();
  room.phase = 'countdown';
  room.deadline = now() + 5000;
  broadcast(room);
}

function startTurn(room) {
  const live = alive(room);
  if (!live.length) return;

  // Keep the rotation stable, dropping leavers and appending anyone who joined
  // mid-game so latecomers still get a turn.
  room.composerOrder = room.composerOrder.filter((id) => room.players.has(id));
  for (const p of live) {
    if (room.composerOrder.indexOf(p.id) < 0) room.composerOrder.push(p.id);
  }
  if (!room.composerOrder.length) return;

  room.turn += 1;
  room.doneVotes.clear();
  room.composerId = room.composerOrder[(room.turn - 1) % room.composerOrder.length];
  room.phase = 'jamturn';
  room.deadline = now() + room.settings.composeTime * 1000;
  broadcast(room);
}

function finishJam(room) {
  room.phase = 'jamdone';
  room.composerId = null;
  room.deadline = now() + 5 * 60000; // generous fallback if the host wanders off
  broadcast(room);
}

function startJamVote(room) {
  // Used up the agreed number of turns? Then it is finished by definition.
  if (room.turn >= room.settings.turns) return finishJam(room);
  room.phase = 'jamvote';
  room.doneVotes.clear();
  room.deadline = now() + JAM_VOTE_TIME;
  broadcast(room);
}

function jamVoteSettled(room) {
  const live = alive(room);
  return live.length > 0 && live.every((p) => room.doneVotes.has(p.id));
}

function afterJamVote(room) {
  // Unanimous "done" ends it. Anything short of that buys another turn, so a
  // silent or absent player can never end the song on everyone else's behalf.
  if (jamVoteSettled(room)) return finishJam(room);
  startTurn(room);
}

// Called ~4x/sec for every room.
function tick() {
  const t = now();
  for (const room of rooms.values()) {
    if (room.players.size === 0) {
      if (t - room.emptyAt > 60000) rooms.delete(room.code);
      continue;
    }
    if (!room.deadline || t < room.deadline) continue;

    switch (room.phase) {
      case 'countdown':
        if (room.mode === 'jam') startTurn(room); else startCompose(room);
        break;
      case 'compose': startListen(room); break;
      case 'listen': nextSong(room); break;
      case 'results':
      case 'final': advanceFromResults(room); break;
      case 'jamturn': startJamVote(room); break;
      case 'jamvote': afterJamVote(room); break;
      case 'jamdone': toLobby(room); broadcast(room); break;
      default: room.deadline = 0;
    }
  }
}
setInterval(tick, 250);

// ---------------------------------------------------------------- messages
function handleJoin(sock, msg, ctx) {
  const name = String(msg.name == null ? '' : msg.name).trim().slice(0, 16) || 'Anon';
  let room;
  if (msg.room) {
    room = rooms.get(String(msg.room).toUpperCase().trim());
    if (!room) return send(sock, { t: 'error', msg: 'No room with that code.' });
    if (room.players.size >= MAX_PLAYERS) {
      return send(sock, { t: 'error', msg: 'That room is full (' + MAX_PLAYERS + ' max).' });
    }
  } else {
    room = createRoom();
  }

  const player = {
    id: 'p' + nextId++,
    name,
    hue: Math.floor(Math.random() * 360),
    sock,
    connected: true,
    score: 0,
    song: room.phase === 'compose' ? blankSong() : null,
    submitted: false,
  };
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;

  ctx.room = room;
  ctx.player = player;

  send(sock, {
    t: 'joined',
    you: { id: player.id, name: player.name, hue: player.hue },
    room: room.code,
  });
  broadcast(room);
}

function handle(msg, ctx) {
  const room = ctx.room;
  const player = ctx.player;
  if (!room || !player) return;
  const isHost = player.id === room.hostId;

  switch (msg.t) {
    case 'settings': {
      if (!isHost || room.phase !== 'lobby') return;
      room.settings.rounds = intIn(msg.rounds, 1, 8, 3);
      room.settings.composeTime = intIn(msg.composeTime, 30, 300, 120);
      room.settings.turns = intIn(msg.turns, 1, 12, 5);
      if (msg.mode === 'jam' || msg.mode === 'clash') room.mode = msg.mode;
      broadcast(room);
      return;
    }
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      if (room.mode === 'jam') startJam(room); else startRound(room);
      return;
    }
    case 'jamdraft': {
      // Only the player whose turn it is may touch the shared song.
      if (room.phase !== 'jamturn' || player.id !== room.composerId) return;
      room.jamSong = sanitizeSong(msg.song);
      // Stream it to the watchers. The composer already has it locally, and
      // echoing it back would fight with whatever they are typing right now.
      for (const p of room.players.values()) {
        if (p.connected && p.id !== player.id) {
          send(p.sock, { t: 'jamsong', song: room.jamSong });
        }
      }
      return;
    }
    case 'endturn': {
      if (room.phase !== 'jamturn') return;
      if (player.id !== room.composerId && !isHost) return;
      room.deadline = now();
      return;
    }
    case 'done': {
      if (room.phase !== 'jamvote') return;
      if (msg.value) room.doneVotes.add(player.id);
      else room.doneVotes.delete(player.id);
      broadcast(room);
      // Everyone agrees: leave a beat to read the room, then wrap it up.
      if (jamVoteSettled(room)) room.deadline = Math.min(room.deadline, now() + 1200);
      return;
    }
    case 'draft': {
      // Autosave. Keeps the work if someone drops out mid-round.
      if (room.phase !== 'compose' && room.phase !== 'countdown') return;
      player.song = sanitizeSong(msg.song);
      return;
    }
    case 'submit': {
      if (room.phase !== 'compose') return;
      player.song = sanitizeSong(msg.song);
      player.submitted = true;
      broadcast(room);
      const live = alive(room);
      if (live.length && live.every((p) => p.submitted)) startListen(room);
      return;
    }
    case 'unsubmit': {
      if (room.phase !== 'compose') return;
      player.submitted = false;
      broadcast(room);
      return;
    }
    case 'rate': {
      if (room.phase !== 'listen') return;
      const authorId = room.order[room.playIndex];
      if (!authorId || authorId === player.id) return;
      // Votes name the song they are for. A star clicked just as the playlist
      // advances belongs to the song that finished, so drop it rather than
      // quietly crediting it to the next track.
      if (typeof msg.index === 'number' && msg.index !== room.playIndex) return;
      room.ratings.set(player.id, intIn(msg.value, 1, 5, 3));
      broadcast(room);
      const needed = alive(room).filter((p) => p.id !== authorId).length;
      if (needed > 0 && room.ratings.size >= needed) {
        // Everyone has voted. Leave a beat to see the result, then move on.
        room.deadline = Math.min(room.deadline, now() + 1500);
      }
      return;
    }
    case 'react': {
      const REACTABLE = ['listen', 'jamturn', 'jamvote', 'jamdone'];
      if (REACTABLE.indexOf(room.phase) < 0) return;
      const emoji = String(msg.emoji == null ? '' : msg.emoji).slice(0, 4);
      if (!emoji) return;
      for (const p of room.players.values()) {
        if (p.connected) send(p.sock, { t: 'react', emoji, from: player.name, hue: player.hue });
      }
      return;
    }
    case 'skip': {
      if (!isHost) return;
      if (room.phase === 'compose' || room.phase === 'countdown') room.deadline = now();
      else if (room.phase === 'listen') nextSong(room);
      else if (room.phase === 'results' || room.phase === 'final') advanceFromResults(room);
      else if (room.phase === 'jamturn') startJamVote(room);
      else if (room.phase === 'jamvote') afterJamVote(room);
      else if (room.phase === 'jamdone') { toLobby(room); broadcast(room); }
      return;
    }
    case 'lobby': {
      if (!isHost) return;
      toLobby(room);
      broadcast(room);
      return;
    }
  }
}

function handleLeave(ctx) {
  const room = ctx.room;
  const player = ctx.player;
  if (!room || !player) return;
  ctx.room = null;
  ctx.player = null;

  player.connected = false;
  player.sock = null;
  const wasPlaying = room.phase === 'listen' && room.order[room.playIndex] === player.id;
  const wasComposing = room.phase === 'jamturn' && room.composerId === player.id;
  room.players.delete(player.id);
  room.ratings.delete(player.id);
  room.doneVotes.delete(player.id);

  if (room.players.size === 0) {
    room.emptyAt = now(); // start the reap clock
    return;
  }
  if (room.hostId === player.id) pickHost(room);

  // A departure can unblock a phase that was waiting on this player.
  if (room.phase === 'compose') {
    const live = alive(room);
    if (live.length && live.every((p) => p.submitted)) return startListen(room);
  }
  if (room.phase === 'listen') {
    if (wasPlaying) return nextSong(room);
    const authorId = room.order[room.playIndex];
    const needed = alive(room).filter((p) => p.id !== authorId).length;
    if (needed > 0 && room.ratings.size >= needed) {
      room.deadline = Math.min(room.deadline, now() + 1200);
    }
  }
  // The composer walked out mid-turn: their work is already saved, so move on.
  if (wasComposing) return startJamVote(room);
  if (room.phase === 'jamvote' && jamVoteSettled(room)) {
    room.deadline = Math.min(room.deadline, now() + 1200);
  }
  broadcast(room);
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^[/\\]+/, ''));
  if (file.indexOf(PUBLIC) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

attach(server, (sock) => {
  const ctx = { room: null, player: null };
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') {
      if (!ctx.player) handleJoin(sock, msg, ctx);
      return;
    }
    handle(msg, ctx);
  });
  sock.on('close', () => handleLeave(ctx));
});

// Keep intermediaries from dropping idle sockets.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) if (p.connected && p.sock) p.sock.ping();
  }
}, 25000);

server.listen(PORT, () => {
  console.log('\n  Musical Mishap is running');
  console.log('  Local:   http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const a of nets[key] || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log('  Network: http://' + a.address + ':' + PORT + '   (share this on your LAN)');
      }
    }
  }
  console.log('');
});
