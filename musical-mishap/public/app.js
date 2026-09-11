'use strict';
/* Musical Mishap client: networking, the studio editor, and synced playback. */
(function () {

const A = window.SongAudio;
const P = window.SongPresets;
const STEPS = A.STEPS;
const DRUM_ROWS = [
  { key: 'kick', label: 'Kick' },
  { key: 'snare', label: 'Snare' },
  { key: 'hat', label: 'Hi-hat' },
  { key: 'clap', label: 'Clap' },
];

const $ = (id) => document.getElementById(id);
const engine = new A.AudioEngine();

const app = {
  ws: null,
  me: null,
  state: null,
  offset: 0,          // serverNow - clientNow
  song: A.emptySong(),
  submitted: false,
  lastPhase: null,
  lastRound: -1,
  lastTurn: -1,
  canEdit: true,      // false while watching someone else's jam turn
  playKey: null,      // guards against restarting audio on every state push
  draftTimer: null,
  cells: { drums: [], bass: [], lead: [] },
};

// ------------------------------------------------------------------ screens
function setScreen(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.remove('active');
  const el = $('screen-' + name);
  if (el) el.classList.add('active');
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// --------------------------------------------------------------- networking
function connect(payload) {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const ws = new WebSocket(proto + location.host);
  app.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify(payload));
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    onMessage(msg);
  };
  ws.onclose = () => {
    engine.stop();
    if (app.me) {
      toast('Disconnected. Reload to rejoin.');
    }
  };
  ws.onerror = () => showHomeError('Could not reach the server.');
}

function send(obj) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(obj));
}

function onMessage(msg) {
  switch (msg.t) {
    case 'joined':
      app.me = msg.you;
      localStorage.setItem('musicalmishap.name', msg.you.name);
      history.replaceState(null, '', '#' + msg.room);
      return;
    case 'state':
      app.offset = msg.now - Date.now();
      app.state = msg;
      render(msg);
      return;
    case 'jamsong':
      // A live edit from whoever is composing this turn.
      adoptJamSong(msg.song);
      return;
    case 'error':
      showHomeError(msg.msg);
      toast(msg.msg);
      return;
    case 'react':
      floatEmoji(msg.emoji, msg.hue);
      return;
  }
}

function showHomeError(text) {
  const el = $('home-error');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// ------------------------------------------------------------------- render
function render(s) {
  document.body.classList.toggle('is-host', !!s.youAreHost);

  const newRound = s.round !== app.lastRound;
  if (s.phase !== app.lastPhase || newRound) {
    onPhaseEnter(s, s.phase !== app.lastPhase, newRound);
    app.lastPhase = s.phase;
    app.lastRound = s.round;
  }

  switch (s.phase) {
    case 'lobby': renderLobby(s); break;
    case 'countdown': renderCountdown(s); break;
    case 'compose': renderCompose(s); break;
    case 'listen': renderListen(s); break;
    case 'results':
    case 'final': renderResults(s); break;
    case 'jamturn': renderJamTurn(s); break;
    case 'jamvote': renderJamVote(s); break;
    case 'jamdone': renderJamDone(s); break;
  }
}

function onPhaseEnter(s, phaseChanged, roundChanged) {
  // Every phase change silences whatever was playing. The new phase decides
  // what starts up again: the listening phase does it automatically, the jam
  // phases wait for the player to press Listen.
  engine.stop();
  app.playKey = null;
  updatePlayButton();

  switch (s.phase) {
    case 'lobby':
      setScreen('lobby');
      break;
    case 'countdown':
      setScreen('countdown');
      // Fresh round, fresh song.
      app.song = A.emptySong();
      app.submitted = false;
      break;
    case 'compose':
      setScreen('compose');
      setWatching(false);
      $('jam-banner').hidden = true;
      if (phaseChanged) buildStudio();
      break;
    case 'jamturn':
      setScreen('compose');
      $('jam-banner').hidden = false;
      // Start the turn from the room's copy of the song, whoever is composing.
      app.song = copySong(s.jam.song);
      app.lastTurn = s.jam.turn;
      setWatching(!s.jam.youAreComposer);
      buildStudio();
      updatePlayButton(); // label depends on whether you can edit
      break;
    case 'jamvote':
      setScreen('jamvote');
      app.song = copySong(s.jam.song);
      engine.load(app.song);
      break;
    case 'jamdone':
      setScreen('jamdone');
      app.song = copySong(s.jam.song);
      engine.load(app.song);
      buildVisualizer(app.song, 'jd-visualizer');
      break;
    case 'listen':
      setScreen('listen');
      break;
    case 'results':
    case 'final':
      setScreen('results');
      break;
  }
}

// -------------------------------------------------------------------- lobby
function renderLobby(s) {
  $('room-code').textContent = s.room;
  $('player-count').textContent = '(' + s.players.length + '/12)';

  const list = $('lobby-players');
  list.innerHTML = '';
  for (const p of s.players) {
    const li = document.createElement('li');
    li.appendChild(dot(p.hue));
    const name = document.createElement('span');
    name.textContent = p.name + (app.me && p.id === app.me.id ? ' (you)' : '');
    li.appendChild(name);
    if (p.id === s.hostId) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'host';
      li.appendChild(tag);
    }
    list.appendChild(li);
  }

  const jam = s.mode === 'jam';
  $('set-mode').value = s.mode || 'clash';
  $('set-rounds').value = s.rounds;
  $('set-turns').value = s.turns;
  $('set-time').value = String(s.composeTime);
  $('row-rounds').hidden = jam;
  $('row-turns').hidden = !jam;
  $('mode-blurb').textContent = jam
    ? 'One song for the whole room. Each turn one player composes while everyone else watches and listens. It ends when everyone agrees it is done, or when the turns run out.'
    : 'Everyone writes their own track to the same theme, then you all rate each other.';
  $('btn-start').textContent = jam ? 'Start the jam' : 'Start the mishap';

  const canStart = s.youAreHost;
  $('btn-start').disabled = !canStart;
  $('set-mode').disabled = !canStart;
  $('set-rounds').disabled = !canStart;
  $('set-turns').disabled = !canStart;
  $('set-time').disabled = !canStart;
  $('lobby-hint').textContent = canStart
    ? (s.players.length < 2 ? 'You can start solo, but it is a lot more fun with friends.' : '')
    : 'Waiting for the host to start.';
}

function dot(hue) {
  const d = document.createElement('span');
  d.className = 'dot';
  d.style.background = 'hsl(' + hue + ' 80% 60%)';
  return d;
}

// ---------------------------------------------------------------- countdown
function renderCountdown(s) {
  $('cd-round').textContent = s.round + ' of ' + s.rounds;
  $('cd-prompt').textContent = s.prompt;
}

// ------------------------------------------------------------------ compose
function renderCompose(s) {
  $('cp-context').textContent = 'Round ' + s.round + ' of ' + s.rounds + ' — theme';
  $('cp-prompt').textContent = s.prompt;

  const list = $('compose-players');
  list.innerHTML = '';
  for (const p of s.players) {
    const li = document.createElement('li');
    if (p.submitted) li.className = 'done';
    li.appendChild(dot(p.hue));
    li.appendChild(document.createTextNode(p.name + (p.submitted ? ' ✓' : '')));
    list.appendChild(li);
  }

  const btn = $('btn-submit');
  btn.textContent = app.submitted ? 'Locked ✓' : 'Lock it in';
  btn.classList.toggle('locked', app.submitted);
}

// ------------------------------------------------------------------- listen
function renderListen(s) {
  const np = s.nowPlaying;
  if (!np) return;

  $('ls-index').textContent = (np.index + 1) + ' of ' + np.total;
  $('ls-prompt').textContent = s.prompt;
  $('ls-title').textContent = np.title || 'Untitled';
  const author = $('ls-author');
  author.textContent = np.authorName;
  author.style.color = 'hsl(' + np.authorHue + ' 80% 65%)';

  const key = 'listen:' + s.round + ':' + np.index;
  if (app.playKey !== key) {
    app.playKey = key;
    buildVisualizer(np.song);
    engine.play(np.song);
  }

  $('ls-rate').hidden = !!s.isYourSong;
  $('ls-own').hidden = !s.isYourSong;
  $('react-bar').hidden = false;

  const stars = $('stars').children;
  for (let i = 0; i < stars.length; i++) {
    stars[i].classList.toggle('lit', i < (s.yourRating || 0));
  }
  $('ls-votes').textContent = s.ratersNeeded
    ? s.ratedCount + ' of ' + s.ratersNeeded + ' voted'
    : '';
}

// --------------------------------------------------------------- jam mode
const copySong = (song) => JSON.parse(JSON.stringify(song));

// Watchers see the grid but cannot touch it; the server would reject the edit
// anyway, so this is purely about not misleading them.
function setWatching(on) {
  app.canEdit = !on;
  $('screen-compose').classList.toggle('watching', on);
}

// A live edit arriving from whoever is composing. Only watchers apply these:
// the composer is the source of truth for their own turn.
function adoptJamSong(song) {
  const s = app.state;
  if (!s || !s.jam || s.jam.youAreComposer) return;
  app.song = copySong(song);
  if (app.cells.lead.length) {
    syncControls();
    relabelPitchGrids();
    refreshGrids();
    $('cp-title').value = app.song.title;
  }
  // Keep a listener's playback in step with the edit they just watched land.
  engine.load(app.song);
  if (s.phase === 'jamvote' || s.phase === 'jamdone') {
    buildVisualizer(app.song, s.phase === 'jamdone' ? 'jd-visualizer' : null);
  }
}

function updatePlayButton() {
  const btn = $('btn-play');
  const label = app.canEdit ? 'Play' : 'Listen';
  btn.textContent = engine.playing ? '■ Stop' : '▶ ' + label;
  btn.classList.toggle('on', engine.playing);
  for (const id of ['btn-jv-listen', 'btn-jd-listen']) {
    const b = $(id);
    if (b) {
      b.textContent = engine.playing ? '■ Stop' : (id === 'btn-jd-listen' ? '▶ Play it' : '▶ Listen to it');
      b.classList.toggle('on', engine.playing);
    }
  }
}

function renderJamTurn(s) {
  const jam = s.jam;
  $('cp-context').textContent = 'Everyone’s song — theme';
  $('cp-prompt').textContent = s.prompt;
  $('jam-turn').textContent = 'Turn ' + jam.turn + ' of ' + jam.turns;
  $('jam-who').textContent = jam.youAreComposer
    ? 'Your turn — everyone is watching'
    : jam.composerName + ' is composing';
  $('jam-who').style.color = 'hsl(' + jam.composerHue + ' 80% 65%)';
  $('jam-note').textContent = jam.youAreComposer
    ? 'Add to what came before. Hit Play any time.'
    : 'You can hit Listen whenever you like — it plays just for you.';

  const btn = $('btn-submit');
  btn.textContent = 'End my turn';
  btn.classList.remove('locked');

  const list = $('compose-players');
  list.innerHTML = '';
  for (const p of s.players) {
    const li = document.createElement('li');
    if (p.id === jam.composerId) li.className = 'done';
    li.appendChild(dot(p.hue));
    li.appendChild(document.createTextNode(p.name + (p.id === jam.composerId ? ' 🎛️' : '')));
    list.appendChild(li);
  }
}

function renderJamVote(s) {
  const jam = s.jam;
  $('jv-turn').textContent = jam.turn + ' of ' + jam.turns;
  $('jv-prompt').textContent = s.prompt;
  $('jv-title').textContent = app.song.title || 'Is it done?';
  $('jv-tally').textContent = jam.doneCount + ' of ' + jam.voterCount + ' say it is done';
  $('jv-names').textContent = jam.doneNames.length ? 'Done: ' + jam.doneNames.join(', ') : '';
  $('jv-left').textContent = jam.turn >= jam.turns - 1
    ? 'Last turn coming up unless everyone calls it now.'
    : (jam.turns - jam.turn) + ' turns left if you keep going.';
  $('btn-done').classList.toggle('chosen', !!jam.yourDone);
  $('btn-more').classList.toggle('chosen', !jam.yourDone);
}

function renderJamDone(s) {
  $('jd-prompt').textContent = s.prompt;
  $('jd-title').textContent = app.song.title || 'Untitled';
  $('jd-turns').textContent = 'Built over ' + s.jam.turn +
    (s.jam.turn === 1 ? ' turn' : ' turns');

  const authors = $('jd-authors');
  authors.innerHTML = '';
  s.players.forEach((p, i) => {
    const span = document.createElement('span');
    span.textContent = p.name;
    span.style.color = 'hsl(' + p.hue + ' 80% 65%)';
    authors.appendChild(span);
    if (i < s.players.length - 1) authors.appendChild(document.createTextNode(', '));
  });
}

// ------------------------------------------------------------------ results
function renderResults(s) {
  const final = s.phase === 'final';
  $('rs-heading').textContent = final ? 'Final scores' : 'Round ' + s.round + ' results';
  $('rs-sub').textContent = final
    ? 'Theme of the last round: ' + s.prompt
    : 'Theme: ' + s.prompt;

  const board = $('rs-board');
  board.innerHTML = '';
  for (let i = 0; i < s.board.length; i++) {
    const p = s.board[i];
    const li = document.createElement('li');
    if (i === 0) li.className = 'first';
    li.appendChild(dot(p.hue));

    const wrap = document.createElement('div');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = p.name;
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = p.title || 'Untitled';
    wrap.appendChild(who);
    wrap.appendChild(what);
    li.appendChild(wrap);

    if (p.song) {
      const play = document.createElement('button');
      play.className = 'listen-btn';
      play.title = 'Play this one';
      play.textContent = '▶';
      play.onclick = () => { app.playKey = null; engine.play(p.song); };
      li.appendChild(play);
    }

    const pts = document.createElement('div');
    pts.className = 'pts';
    if (final) {
      pts.textContent = p.score;
    } else {
      pts.innerHTML = '+' + p.roundScore + ' <small>/ ' + p.score + '</small>';
    }
    li.appendChild(pts);
    board.appendChild(li);
  }

  $('btn-continue').textContent = final ? 'Back to the lobby' : 'Next round';
  $('rs-wait').textContent = s.youAreHost ? '' : 'Waiting for the host...';
  const top = s.board[0];
  $('btn-replay').disabled = !(top && top.song);
  $('btn-replay').onclick = () => {
    if (top && top.song) { app.playKey = null; engine.play(top.song); }
  };
}

// ------------------------------------------------------------- studio build
function buildStudio() {
  buildGrid('drums');
  buildGrid('bass');
  buildGrid('lead');
  syncControls();
  refreshGrids();
  $('cp-title').value = app.song.title;
  resetPresetPicker();
}

// The picker names a starting point, not a persistent property of the song, so
// it goes back to neutral whenever the studio is rebuilt or wiped.
function resetPresetPicker() {
  $('set-preset').value = '';
  $('preset-blurb').textContent = '';
}

function rowCount(kind) {
  if (kind === 'drums') return DRUM_ROWS.length;
  if (kind === 'bass') return A.BASS_ROWS;
  return A.LEAD_ROWS;
}

function labelFor(kind, rowIndex) {
  if (kind === 'drums') return DRUM_ROWS[rowIndex].label;
  const base = kind === 'bass' ? 36 : 60;
  return A.noteLabel(rowIndex, app.song.scale, app.song.root, base);
}

function buildGrid(kind) {
  const host = $('grid-' + kind);
  host.className = 'grid grid-' + kind;
  host.innerHTML = '';
  const rows = rowCount(kind);
  app.cells[kind] = [];

  // Pitched grids draw high notes first so they read like a piano roll. Drums
  // have no pitch order, so they keep their natural kick-first listing.
  const order = [];
  if (kind === 'drums') for (let r = 0; r < rows; r++) order.push(r);
  else for (let r = rows - 1; r >= 0; r--) order.push(r);

  for (const r of order) {
    const rowEl = document.createElement('div');
    rowEl.className = 'grid-row';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = labelFor(kind, r);
    label.dataset.kind = kind;
    label.dataset.row = String(r);
    label.title = 'Click to hear it';
    rowEl.appendChild(label);

    const rowCells = [];
    for (let step = 0; step < STEPS; step++) {
      const cell = document.createElement('div');
      let cls = 'cell';
      if (step % 4 === 0) cls += ' beat';
      if (step % 16 === 0) cls += ' bar';
      cell.className = cls;
      cell.dataset.kind = kind;
      cell.dataset.row = String(r);
      cell.dataset.step = String(step);
      rowEl.appendChild(cell);
      rowCells.push(cell);
    }
    app.cells[kind][r] = rowCells;
    host.appendChild(rowEl);
  }
}

function relabelPitchGrids() {
  for (const kind of ['bass', 'lead']) {
    const labels = $('grid-' + kind).querySelectorAll('.row-label');
    for (const el of labels) {
      el.textContent = labelFor(kind, Number(el.dataset.row));
    }
  }
}

function refreshGrids() {
  const song = app.song;
  for (let r = 0; r < DRUM_ROWS.length; r++) {
    const arr = song.drums[DRUM_ROWS[r].key];
    const cells = app.cells.drums[r];
    for (let s = 0; s < STEPS; s++) cells[s].classList.toggle('on', !!arr[s]);
  }
  for (let r = 0; r < A.BASS_ROWS; r++) {
    const cells = app.cells.bass[r];
    for (let s = 0; s < STEPS; s++) cells[s].classList.toggle('on', song.bass[s] === r);
  }
  for (let r = 0; r < A.LEAD_ROWS; r++) {
    const cells = app.cells.lead[r];
    for (let s = 0; s < STEPS; s++) cells[s].classList.toggle('on', !!song.lead[s][r]);
  }
}

// ------------------------------------------------------------ studio edits
let painting = null; // {kind, value}

function readCell(kind, row, step) {
  if (kind === 'drums') return !!app.song.drums[DRUM_ROWS[row].key][step];
  if (kind === 'bass') return app.song.bass[step] === row;
  return !!app.song.lead[step][row];
}

function writeCell(kind, row, step, value) {
  const song = app.song;
  if (kind === 'drums') {
    song.drums[DRUM_ROWS[row].key][step] = value ? 1 : 0;
  } else if (kind === 'bass') {
    // Monophonic: a column holds at most one bass note.
    song.bass[step] = value ? row : (song.bass[step] === row ? -1 : song.bass[step]);
    const cells = app.cells.bass;
    for (let r = 0; r < A.BASS_ROWS; r++) cells[r][step].classList.toggle('on', song.bass[step] === r);
    queueDraft();
    return;
  } else {
    song.lead[step][row] = value ? 1 : 0;
  }
  app.cells[kind][row][step].classList.toggle('on', value);
  queueDraft();
}

function cellFrom(target) {
  if (!target || !target.classList || !target.classList.contains('cell')) return null;
  return {
    kind: target.dataset.kind,
    row: Number(target.dataset.row),
    step: Number(target.dataset.step),
  };
}

function onPointerDown(ev) {
  if (!app.canEdit) return; // watching someone else's jam turn
  const info = cellFrom(ev.target);
  if (!info) {
    const label = ev.target.closest ? ev.target.closest('.row-label') : null;
    if (label) {
      const kind = label.dataset.kind;
      const row = Number(label.dataset.row);
      engine.preview(app.song, kind === 'drums' ? DRUM_ROWS[row].key : kind, row);
    }
    return;
  }
  ev.preventDefault();
  const value = !readCell(info.kind, info.row, info.step);
  painting = { kind: info.kind, value };
  writeCell(info.kind, info.row, info.step, value);
  if (value) {
    engine.preview(app.song, info.kind === 'drums' ? DRUM_ROWS[info.row].key : info.kind, info.row);
  }
}

function onPointerOver(ev) {
  if (!painting) return;
  const info = cellFrom(ev.target);
  if (!info || info.kind !== painting.kind) return;
  if (readCell(info.kind, info.row, info.step) === painting.value) return;
  writeCell(info.kind, info.row, info.step, painting.value);
}

function queueDraft() {
  clearTimeout(app.draftTimer);
  const jam = app.state && app.state.phase === 'jamturn';
  // In jam mode this doubles as the live feed the watchers see, so it goes out
  // a little more eagerly than a plain autosave.
  app.draftTimer = setTimeout(
    () => send({ t: jam ? 'jamdraft' : 'draft', song: app.song }),
    jam ? 250 : 600
  );
}

function syncControls() {
  const s = app.song;
  $('set-tempo').value = s.tempo;
  $('lbl-tempo').textContent = s.tempo;
  $('set-root').value = String(s.root);
  $('set-scale').value = s.scale;
  $('set-kit').value = String(s.kit);
  $('set-leadwave').value = String(s.leadWave);
  $('set-basswave').value = String(s.bassWave);
  $('set-cutoff').value = Math.round(s.cutoff * 100);
  $('set-swing').value = Math.round(s.swing * 100);
  $('set-delay').checked = !!s.delay;
}

// ----------------------------------------------------------- presets
function loadPreset(preset, soundOnly) {
  if (!app.canEdit || !preset) return;
  const song = soundOnly ? app.song : A.emptySong();
  if (!soundOnly) {
    // Keep the things that are the player's choice, not the style's.
    song.title = app.song.title;
    song.root = app.song.root;
  }
  P.applyPreset(song, preset, { soundOnly, bassRows: A.BASS_ROWS });
  app.song = song;

  syncControls();
  relabelPitchGrids();
  refreshGrids();
  $('cp-title').value = app.song.title;
  if (engine.playing) engine.load(app.song);
  queueDraft();
}

// The dice now rolls a real style and then messes with it, which beats the
// shapeless noise a fully random pattern used to produce.
function randomGroove() {
  const preset = P.PRESETS[Math.floor(Math.random() * P.PRESETS.length)];
  const song = A.emptySong();
  song.title = app.song.title;
  P.applyPreset(song, preset, { bassRows: A.BASS_ROWS });

  song.root = Math.floor(Math.random() * 12);
  song.tempo = Math.max(60, Math.min(170, song.tempo + Math.floor(Math.random() * 25) - 12));

  // Thin out and thicken the kit a little so two rolls of the same style
  // never come out identical.
  for (let s = 0; s < STEPS; s++) {
    if (song.drums.hat[s] && Math.random() < 0.15) song.drums.hat[s] = 0;
    if (!song.drums.hat[s] && s % 2 === 1 && Math.random() < 0.12) song.drums.hat[s] = 1;
    if (!song.drums.clap[s] && s % 16 === 14 && Math.random() < 0.35) song.drums.clap[s] = 1;
  }

  // Nudge a few melody notes to a neighbouring degree in the same scale.
  for (let s = 0; s < STEPS; s++) {
    for (let r = 0; r < A.LEAD_ROWS; r++) {
      if (!song.lead[s][r] || Math.random() > 0.22) continue;
      const moved = r + (Math.random() < 0.5 ? -1 : 1);
      if (moved < 0 || moved >= A.LEAD_ROWS) continue;
      song.lead[s][r] = 0;
      song.lead[s][moved] = 1;
    }
  }
  return song;
}

// -------------------------------------------------------------- visualizer
function buildVisualizer(song, hostId) {
  const host = $(hostId || 'visualizer');
  host.innerHTML = '';
  const events = A.compile(song);
  const heights = [];
  for (let s = 0; s < STEPS; s++) {
    let energy = 0;
    const d = song.drums;
    energy += d.kick[s] * 3 + d.snare[s] * 2.4 + d.hat[s] * 1 + d.clap[s] * 2;
    energy += events[s].bass ? 2.5 : 0;
    energy += events[s].lead.length * 2;
    heights.push(energy);
  }
  const max = Math.max(1, ...heights);
  for (let s = 0; s < STEPS; s++) {
    const bar = document.createElement('div');
    bar.className = 'viz-bar';
    bar.style.height = (8 + (heights[s] / max) * 92) + '%';
    host.appendChild(bar);
  }
}

engine.onStep = (step) => {
  // Playhead in the studio grid.
  const phase = app.state && app.state.phase;
  if (phase === 'compose' || phase === 'jamturn') {
    for (const kind of ['drums', 'bass', 'lead']) {
      const rows = app.cells[kind];
      for (let r = 0; r < rows.length; r++) {
        const cells = rows[r];
        if (!cells) continue;
        for (let s = 0; s < STEPS; s++) cells[s].classList.toggle('playhead', s === step);
      }
    }
    return;
  }
  // Bar highlight in whichever visualizer is on screen.
  const bars = $(phase === 'jamdone' ? 'jd-visualizer' : 'visualizer').children;
  for (let i = 0; i < bars.length; i++) bars[i].classList.toggle('hot', i === step);
};

// --------------------------------------------------------------- reactions
function floatEmoji(emoji, hue) {
  const el = document.createElement('div');
  el.className = 'float-emoji';
  el.textContent = emoji;
  el.style.left = (5 + Math.random() * 90) + '%';
  el.style.bottom = '10%';
  el.style.filter = 'drop-shadow(0 0 8px hsl(' + hue + ' 80% 60%))';
  $('reactions').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

// ------------------------------------------------------------- clock ticks
setInterval(() => {
  const s = app.state;
  if (!s || !s.deadline) return;
  const remain = s.deadline - (Date.now() + app.offset);

  if (s.phase === 'jamvote') {
    const left = Math.max(0, Math.ceil(remain / 1000));
    $('jv-tally').textContent = s.jam.doneCount + ' of ' + s.jam.voterCount +
      ' say it is done — ' + left + 's';
    return;
  }
  if (s.phase === 'countdown') {
    $('cd-number').textContent = Math.max(0, Math.ceil(remain / 1000));
  } else if (s.phase === 'compose' || s.phase === 'jamturn') {
    const el = $('cp-timer');
    el.textContent = fmtTime(remain);
    el.classList.toggle('warn', remain <= 30000 && remain > 10000);
    el.classList.toggle('danger', remain <= 10000);
    const total = s.composeTime * 1000;
    $('cp-timer-fill').style.width = Math.max(0, Math.min(100, (remain / total) * 100)) + '%';
  }
}, 200);

// ------------------------------------------------------------------- wiring
function initSelects() {
  const root = $('set-root');
  A.NOTE_NAMES.forEach((n, i) => root.add(new Option(n, String(i))));
  const scale = $('set-scale');
  for (const key of Object.keys(A.SCALES)) scale.add(new Option(A.SCALE_NAMES[key], key));
  const kit = $('set-kit');
  A.KIT_NAMES.forEach((n, i) => kit.add(new Option(n, String(i))));
  const lw = $('set-leadwave');
  A.LEAD_WAVES.forEach((n, i) => lw.add(new Option(n, String(i))));
  const bw = $('set-basswave');
  A.BASS_WAVES.forEach((n, i) => bw.add(new Option(n, String(i))));

  // Presets, grouped so the genres and the scene flavours read apart.
  const presetSel = $('set-preset');
  const groups = {};
  for (const preset of P.PRESETS) {
    if (!groups[preset.group]) {
      const g = document.createElement('optgroup');
      g.label = preset.group;
      presetSel.appendChild(g);
      groups[preset.group] = g;
    }
    groups[preset.group].appendChild(new Option(preset.name, preset.id));
  }

  const starBar = $('stars');
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.className = 'star';
    b.textContent = '★';
    b.setAttribute('aria-label', i + ' stars');
    b.onclick = () => {
      const np = app.state && app.state.nowPlaying;
      if (!np) return;
      send({ t: 'rate', value: i, index: np.index });
    };
    starBar.appendChild(b);
  }

  for (const barId of ['react-bar', 'jd-react-bar']) {
    const bar = $(barId);
    for (const e of ['🔥', '😂', '💀', '👏', '🎉']) {
      const b = document.createElement('button');
      b.textContent = e;
      b.onclick = () => send({ t: 'react', emoji: e });
      bar.appendChild(b);
    }
  }
}

function wire() {
  const savedName = localStorage.getItem('musicalmishap.name');
  if (savedName) $('input-name').value = savedName;
  const hash = location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(hash)) $('input-code').value = hash;

  const name = () => $('input-name').value.trim() || 'Anon';

  $('btn-create').onclick = () => {
    engine.init(); // unlock audio while we still have the user gesture
    showHomeError('');
    connect({ t: 'join', name: name(), room: '' });
  };
  $('btn-join').onclick = () => {
    const code = $('input-code').value.trim().toUpperCase();
    if (code.length !== 4) return showHomeError('Room codes are four characters.');
    engine.init();
    showHomeError('');
    connect({ t: 'join', name: name(), room: code });
  };
  $('input-code').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
  $('input-name').onkeydown = (e) => { if (e.key === 'Enter') $('btn-create').click(); };

  $('btn-copy').onclick = async () => {
    const url = location.origin + '/#' + (app.state ? app.state.room : '');
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (e) {
      toast(url);
    }
  };

  const pushSettings = () => send({
    t: 'settings',
    mode: $('set-mode').value,
    rounds: Number($('set-rounds').value),
    turns: Number($('set-turns').value),
    composeTime: Number($('set-time').value),
  });
  $('set-mode').onchange = pushSettings;
  $('set-rounds').onchange = pushSettings;
  $('set-turns').onchange = pushSettings;
  $('set-time').onchange = pushSettings;
  $('btn-start').onclick = () => send({ t: 'start' });

  // ---- studio controls
  const togglePlayback = () => {
    engine.toggle(app.song);
    if (engine.playing) engine.load(app.song);
    updatePlayButton();
  };
  $('btn-play').onclick = togglePlayback;
  $('btn-jv-listen').onclick = togglePlayback;
  $('btn-jd-listen').onclick = togglePlayback;
  $('btn-clear').onclick = () => {
    const title = app.song.title;
    app.song = A.emptySong();
    app.song.title = title;
    syncControls();
    relabelPitchGrids();
    refreshGrids();
    resetPresetPicker();
    queueDraft();
  };
  $('set-preset').onchange = (e) => {
    const preset = P.byId(e.target.value);
    if (!preset) { $('preset-blurb').textContent = ''; return; }
    $('preset-blurb').textContent = preset.blurb;
    loadPreset(preset, $('set-preset-keep').checked);
    toast($('set-preset-keep').checked
      ? preset.name + ' sound applied — your notes are untouched'
      : preset.name + ' loaded. Now make it yours.');
  };

  $('btn-dice').onclick = () => {
    app.song = randomGroove();
    syncControls();
    relabelPitchGrids();
    refreshGrids();
    if (engine.playing) engine.load(app.song);
    queueDraft();
  };

  const live = (id, fn) => {
    const el = $(id);
    el.oninput = () => {
      fn(el);
      if (engine.playing) engine.load(app.song);
      queueDraft();
    };
  };
  live('set-tempo', (el) => {
    app.song.tempo = Number(el.value);
    $('lbl-tempo').textContent = el.value;
  });
  live('set-cutoff', (el) => { app.song.cutoff = Number(el.value) / 100; });
  live('set-swing', (el) => { app.song.swing = Number(el.value) / 100; });
  $('set-delay').onchange = (e) => {
    app.song.delay = e.target.checked ? 1 : 0;
    engine.load(app.song);
    queueDraft();
  };
  $('set-root').onchange = (e) => {
    app.song.root = Number(e.target.value);
    relabelPitchGrids();
    queueDraft();
  };
  $('set-scale').onchange = (e) => {
    app.song.scale = e.target.value;
    relabelPitchGrids();
    queueDraft();
  };
  $('set-kit').onchange = (e) => { app.song.kit = Number(e.target.value); queueDraft(); };
  $('set-leadwave').onchange = (e) => { app.song.leadWave = Number(e.target.value); queueDraft(); };
  $('set-basswave').onchange = (e) => { app.song.bassWave = Number(e.target.value); queueDraft(); };

  $('cp-title').oninput = (e) => { app.song.title = e.target.value; queueDraft(); };

  $('btn-done').onclick = () => send({ t: 'done', value: true });
  $('btn-more').onclick = () => send({ t: 'done', value: false });
  $('btn-jd-lobby').onclick = () => send({ t: 'skip' });

  $('btn-submit').onclick = () => {
    // In a jam turn this button ends your turn instead of locking a track in.
    if (app.state && app.state.phase === 'jamturn') {
      send({ t: 'jamdraft', song: app.song });
      send({ t: 'endturn' });
      return;
    }
    app.submitted = !app.submitted;
    if (app.submitted) {
      send({ t: 'submit', song: app.song });
      toast('Locked in. You can still unlock and tweak.');
    } else {
      send({ t: 'unsubmit' });
    }
    if (app.state) renderCompose(app.state);
  };

  $('grids').addEventListener('pointerdown', onPointerDown);
  $('grids').addEventListener('pointerover', onPointerOver);
  window.addEventListener('pointerup', () => { painting = null; });
  window.addEventListener('pointercancel', () => { painting = null; });

  $('btn-skip-compose').onclick = () => send({ t: 'skip' });
  $('btn-skip-listen').onclick = () => send({ t: 'skip' });
  $('btn-continue').onclick = () => send({ t: 'skip' });

  // Spacebar toggles playback in the studio, unless you are typing.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const phase = app.state && app.state.phase;
    if (phase !== 'compose' && phase !== 'jamturn') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    $('btn-play').click();
  });
}

initSelects();
wire();

// Debug handle: handy from the console when tuning sounds or chasing timing.
window.__mishap = { app, engine };

})();
