'use strict';
/* End-to-end check of jam mode: one shared song passed around, live streaming
   to watchers, the "is it done?" vote, and the turn cap.
   Run with:  node test/jam.test.js  */

const assert = require('assert');
const { startServer, player, songWithNotes, reporter } = require('./harness');

const PORT = 8124;

async function main() {
  const server = startServer(PORT);
  await server.ready;
  const check = reporter();

  const ada = player('Ada', PORT);
  const grace = player('Grace', PORT);

  await ada.open;
  ada.send({ t: 'join', name: 'Ada', room: '' });
  const lobby = await ada.until((s) => s.phase === 'lobby', 'lobby');

  await grace.open;
  grace.send({ t: 'join', name: 'Grace', room: lobby.room });
  await ada.until((s) => s.players.length === 2, 'second player');

  // ---------------------------------------------------------- settings
  ada.send({ t: 'settings', mode: 'jam', turns: 3, composeTime: 30 });
  await ada.until((s) => s.mode === 'jam', 'jam mode');
  await grace.until((s) => s.mode === 'jam', 'jam mode reaching Grace');
  check('host can switch the room to jam mode', () => {
    assert.strictEqual(ada.state.mode, 'jam');
    assert.strictEqual(ada.state.turns, 3);
  });
  check('the mode change reaches other players', () =>
    assert.strictEqual(grace.state.mode, 'jam'));

  // ------------------------------------------------------------- turn 1
  ada.send({ t: 'start' });
  await ada.until((s) => s.phase === 'jamturn' && s.jam.turn === 1, 'turn 1');
  await grace.until((s) => s.phase === 'jamturn' && s.jam.turn === 1, 'turn 1 for Grace');
  check('turn 1 has one composer and one watcher', () => {
    assert.strictEqual(ada.state.jam.youAreComposer, true);
    assert.strictEqual(grace.state.jam.youAreComposer, false);
    assert.strictEqual(grace.state.jam.composerName, 'Ada');
  });
  check('the shared song starts empty', () =>
    assert.strictEqual(ada.state.jam.song.drums.kick.indexOf(1), -1));

  // The composer's edits stream to the watcher.
  const draft = songWithNotes({ title: 'Trolley Pursuit' });
  ada.send({ t: 'jamdraft', song: draft });
  const pushed = await grace.until((m) => m.t === 'jamsong', 'live song push');
  check('the watcher receives the composer\'s edits live', () => {
    assert.strictEqual(pushed.song.title, 'Trolley Pursuit');
    assert.strictEqual(pushed.song.drums.kick[0], 1);
  });

  // A watcher must not be able to edit the shared song.
  const vandal = songWithNotes({ title: 'Grace Was Here', tempo: 60 });
  grace.send({ t: 'jamdraft', song: vandal });
  await new Promise((r) => setTimeout(r, 300));
  ada.send({ t: 'endturn' });

  await ada.until((s) => s.phase === 'jamvote', 'vote after turn 1');
  check('a watcher cannot edit the shared song', () =>
    assert.strictEqual(ada.state.jam.song.title, 'Trolley Pursuit'));
  check('the composer can end their own turn early', () =>
    assert.strictEqual(ada.state.jam.turn, 1));

  // ------------------------------------------------- vote: keep going
  ada.send({ t: 'done', value: true });
  await grace.until((s) => s.phase === 'jamvote' && s.jam.doneCount === 1, 'one done vote');
  check('a single done vote does not end the song', () => {
    assert.strictEqual(grace.state.phase, 'jamvote');
    assert.strictEqual(grace.state.jam.doneCount, 1);
    assert.strictEqual(grace.state.jam.voterCount, 2);
  });

  // Grace never agrees, so the vote times out into another turn.
  await ada.until((s) => s.phase === 'jamturn' && s.jam.turn === 2, 'turn 2', 32000);
  await grace.until((s) => s.phase === 'jamturn' && s.jam.turn === 2, 'turn 2 for Grace');
  check('turn passes to the next player', () => {
    assert.strictEqual(grace.state.jam.youAreComposer, true);
    assert.strictEqual(ada.state.jam.composerName, 'Grace');
  });
  check('turn 2 inherits the song from turn 1', () =>
    assert.strictEqual(grace.state.jam.song.title, 'Trolley Pursuit'));

  // Grace adds to what Ada left behind.
  const grown = songWithNotes({ title: 'Trolley Pursuit' });
  grown.drums.clap[4] = 1;
  grace.send({ t: 'jamdraft', song: grown });
  await new Promise((r) => setTimeout(r, 250));
  grace.send({ t: 'endturn' });
  await grace.until((s) => s.phase === 'jamvote' && s.jam.turn === 2, 'vote after turn 2');

  // ------------------------------------------ vote: everyone says done
  ada.send({ t: 'done', value: true });
  grace.send({ t: 'done', value: true });
  await ada.until((s) => s.phase === 'jamdone', 'finished song', 8000);
  check('a unanimous vote ends the song early', () => {
    assert.strictEqual(ada.state.phase, 'jamdone');
    assert.strictEqual(ada.state.jam.turn, 2, 'should stop before the turn cap');
  });
  check('the finished song keeps every turn\'s work', () => {
    assert.strictEqual(ada.state.jam.song.drums.clap[4], 1);
    assert.strictEqual(ada.state.jam.song.title, 'Trolley Pursuit');
  });
  check('both players see the same finished song', () =>
    assert.deepStrictEqual(grace.state.jam.song, ada.state.jam.song));

  // --------------------------------------------------- the turn cap
  ada.send({ t: 'skip' }); // host: back to the lobby
  await ada.until((s) => s.phase === 'lobby', 'lobby again');
  ada.send({ t: 'settings', mode: 'jam', turns: 1, composeTime: 30 });
  await ada.until((s) => s.turns === 1, 'one-turn setting');
  ada.send({ t: 'start' });
  await ada.until((s) => s.phase === 'jamturn', 'capped turn 1');
  ada.send({ t: 'endturn' });
  await ada.until((s) => s.phase === 'jamdone', 'cap ends the song', 8000);
  check('hitting the turn cap ends the song with no vote', () => {
    assert.strictEqual(ada.state.phase, 'jamdone');
    assert.strictEqual(ada.state.jam.turn, 1);
  });
  check('the vote phase was skipped entirely at the cap', () =>
    assert.strictEqual(ada.log.lastIndexOf('jamvote') < ada.log.lastIndexOf('jamturn'), true));

  ada.ws.close();
  grace.ws.close();
  server.proc.kill();
  check.finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
