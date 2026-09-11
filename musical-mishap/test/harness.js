'use strict';
/* Shared bits for the end-to-end tests: a scripted WebSocket player, a server
   launcher, and a tiny assertion reporter. */

const { spawn } = require('child_process');
const path = require('path');

function startServer(port) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  const ready = new Promise((res) => proc.stdout.once('data', res));
  return { proc, ready };
}

function player(name, port) {
  const p = {
    name,
    ws: new WebSocket('ws://localhost:' + port),
    state: null,
    id: null,
    log: [],
    inbox: [],       // non-state messages, e.g. jamsong pushes
    waiters: [],
  };

  const settle = (msg) => {
    for (const w of p.waiters.slice()) {
      if (w.test(msg)) {
        p.waiters.splice(p.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  };

  p.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'joined') p.id = msg.you.id;
    if (msg.t === 'state') {
      p.state = msg;
      p.log.push(msg.phase);
      settle(msg);
    } else {
      p.inbox.push(msg);
      settle(msg);
    }
  });

  p.send = (o) => p.ws.send(JSON.stringify(o));

  // Resolve as soon as a message matches, including one already in hand.
  p.until = (test, label, timeout) => new Promise((resolve, reject) => {
    if (p.state && test(p.state)) return resolve(p.state);
    const w = { test, resolve };
    p.waiters.push(w);
    setTimeout(() => {
      if (p.waiters.indexOf(w) >= 0) {
        p.waiters.splice(p.waiters.indexOf(w), 1);
        reject(new Error(name + ' timed out waiting for ' + label +
          ' (saw: ' + p.log.join(' > ') + ')'));
      }
    }, timeout || 15000);
  });

  p.open = new Promise((res) => p.ws.addEventListener('open', res));
  return p;
}

function songWithNotes(overrides) {
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
  return Object.assign({
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
  }, overrides || {});
}

function reporter() {
  const failures = [];
  const check = (label, fn) => {
    try { fn(); console.log('  ok   ' + label); }
    catch (e) {
      failures.push(label);
      console.log('  FAIL ' + label + ' -- ' + e.message);
    }
  };
  check.finish = () => {
    console.log('');
    if (failures.length) {
      console.log(failures.length + ' failing check(s)');
      process.exit(1);
    }
    console.log('all checks passed');
    process.exit(0);
  };
  return check;
}

module.exports = { startServer, player, songWithNotes, reporter };
