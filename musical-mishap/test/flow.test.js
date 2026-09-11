'use strict';
/* Headless end-to-end check: spins up the server, drives two players through a
   two full rounds over real WebSockets, and asserts the scoring.
   Run with:  node test/flow.test.js  */

const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 8123;
const URL = 'ws://localhost:' + PORT;

function player(name) {
  const p = {
    name,
    ws: new WebSocket(URL),
    state: null,
    id: null,
    log: [],
    waiters: [],
  };
  p.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'joined') p.id = msg.you.id;
    if (msg.t === 'state') {
      p.state = msg;
      p.log.push(msg.phase);
      for (const w of p.waiters.slice()) {
        if (w.test(msg)) {
          p.waiters.splice(p.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    }
  });
  p.send = (o) => p.ws.send(JSON.stringify(o));
  p.until = (test, label) => new Promise((resolve, reject) => {
    if (p.state && test(p.state)) return resolve(p.state);
    const w = { test, resolve };
    p.waiters.push(w);
    setTimeout(() => {
      if (p.waiters.indexOf(w) >= 0) {
        p.waiters.splice(p.waiters.indexOf(w), 1);
        reject(new Error(name + ' timed out waiting for ' + label +
          ' (saw: ' + p.log.join(' > ') + ')'));
      }
    }, 15000);
  });
  p.open = new Promise((res) => p.ws.addEventListener('open', res));
  return p;
}

function songWithNotes() {
  const lead = [];
  const bass = [];
  for (let i = 0; i < 32; i++) {
    lead.push(new Array(12).fill(0));
    bass.push(i % 8 === 0 ? 0 : -1);
  }
  lead[0][3] = 1;
  lead[8][5] = 1;
  const kick = new Array(32).fill(0);
  kick[0] = kick[8] = kick[16] = kick[24] = 1;
  const zeros = () => new Array(32).fill(0);
  return {
    title: 'Test Track',
    tempo: 140,
    root: 0,
    scale: 'minorPent',
    swing: 0,
    kit: 0,
    drums: { kick, snare: zeros(), hat: zeros(), clap: zeros() },
    bass,
    lead,
    leadWave: 0,
    bassWave: 0,
    cutoff: 0.7,
    delay: 0,
  };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((res) => server.stdout.once('data', res));

  const failures = [];
  const check = (label, fn) => {
    try { fn(); console.log('  ok   ' + label); }
    catch (e) { failures.push(label + ': ' + e.message); console.log('  FAIL ' + label + ' -- ' + e.message); }
  };

  const ada = player('Ada');
  const grace = player('Grace');

  await ada.open;
  ada.send({ t: 'join', name: 'Ada', room: '' });
  const lobby = await ada.until((s) => s.phase === 'lobby', 'lobby');
  const code = lobby.room;

  await grace.open;
  grace.send({ t: 'join', name: 'Grace', room: code });
  await ada.until((s) => s.players.length === 2, 'second player');
  check('two players in the room', () => assert.strictEqual(ada.state.players.length, 2));

  const ROUNDS = 2;
  ada.send({ t: 'settings', rounds: ROUNDS, composeTime: 30 });
  ada.send({ t: 'start' });

  const prompts = [];
  for (let round = 1; round <= ROUNDS; round++) {
    await ada.until((s) => s.phase === 'compose' && s.round === round, 'compose r' + round);
    check('round ' + round + ' has a prompt', () => assert.ok(ada.state.prompt.length > 3));
    prompts.push(ada.state.prompt);

    const adaSong = songWithNotes(); adaSong.title = 'Trolley Pursuit';
    const graceSong = songWithNotes(); graceSong.title = 'Aisle Seven Getaway';
    ada.send({ t: 'submit', song: adaSong });
    grace.send({ t: 'submit', song: graceSong });

    await ada.until((s) => s.phase === 'listen', 'listen r' + round);
    check('round ' + round + ': both submissions made the playlist', () =>
      assert.strictEqual(ada.state.nowPlaying.total, 2));

    // Rate every song, from whichever player is not its author.
    for (let i = 0; i < 2; i++) {
      await ada.until((s) => s.phase === 'listen' && s.nowPlaying.index === i, 'song ' + i);
      const authorId = ada.state.nowPlaying.authorId;
      const voter = authorId === ada.id ? grace : ada;
      const stars = authorId === ada.id ? 4 : 5;

      // Give the client state a moment to settle, exactly like a human clicking.
      await new Promise((r) => setTimeout(r, 300));
      // A stale vote (one aimed at an earlier song) must be ignored outright.
      voter.send({ t: 'rate', value: 1, index: i - 1 });
      voter.send({ t: 'rate', value: stars, index: i });
      await voter.until((s) => s.phase !== 'listen' || s.nowPlaying.index !== i,
        'song ' + i + ' to end');
    }

    if (round < ROUNDS) {
      await ada.until((s) => s.phase === 'results', 'round ' + round + ' results');
      check('round ' + round + ' banks its points', () => {
        const me = ada.state.board.find((p) => p.name === 'Ada');
        assert.strictEqual(me.roundScore, 80);
      });
      ada.send({ t: 'skip' }); // host clicks "Next round"
    }
  }

  await ada.until((s) => s.phase === 'final', 'final scores');
  check('each round drew a different prompt', () =>
    assert.notStrictEqual(prompts[0], prompts[1]));
  const board = ada.state.board;
  const byName = {};
  for (const p of board) byName[p.name] = p;

  check('Ada total is 2 rounds of 4 stars (160)', () => assert.strictEqual(byName.Ada.score, 160));
  check('Grace total is 2 rounds of 5 stars (200)', () => assert.strictEqual(byName.Grace.score, 200));
  check('winner is sorted first', () => assert.strictEqual(board[0].name, 'Grace'));
  check('titles survived the round trip', () =>
    assert.strictEqual(byName.Ada.title, 'Trolley Pursuit'));

  ada.ws.close();
  grace.ws.close();
  server.kill();

  console.log('');
  if (failures.length) {
    console.log(failures.length + ' failing check(s)');
    process.exit(1);
  }
  console.log('all checks passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
