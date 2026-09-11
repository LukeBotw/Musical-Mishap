# Musical Mishap

A browser party game in the shape of Gartic Phone, but for music. Everyone gets
the same silly theme and two minutes in a tiny studio. Then all the tracks play
back one at a time and everyone rates them. Highest total wins.

No dependencies, no build step, no accounts.

## Running it

```bash
node server.js
```

Then open `http://localhost:8080`. The console also prints a LAN address — send
that to everyone on the same wifi, or share the room link from the lobby.

Set a different port with `PORT=3000 node server.js`.

## Two modes

The host picks one in the lobby.

**Clash** — competitive. Everyone writes their own track to the same theme, then
you all rate each other. Described below.

**Jam** — co-op. One song for the whole room, passed from player to player a
turn at a time. Described further down.

## Clash: how a round works

1. **Lobby** — the host picks the number of rounds and how long the studio phase
   lasts, then starts. Up to 12 players per room.
2. **Theme** — a five second countdown reveals the prompt, the same one for
   everybody. Something like *a goose that owes you money*.
3. **Studio** — two minutes by default. Four drum lanes, a bass lane, and a
   twelve note melody grid, plus tempo, key, scale, drum kit, two synth voices,
   a filter, swing, and an echo. Every grid row is snapped to the chosen scale,
   so nothing you write can be truly out of tune. **Inspire me** rolls a
   starter groove when the blank page is the enemy.
4. **Listening** — each track plays in a random order with its author revealed.
   Everyone rates it one to five stars, except its author. Emoji fly.
5. **Scores** — a track's score is its average star rating times twenty, so it
   reads as a percentage. Scores accumulate across rounds.

Locking in early is fine; when everyone has locked in, the round moves on
without waiting out the clock. You can unlock and keep tweaking until then.

## Jam: one song, passed around

The whole room builds a single track together.

1. **Theme** — one prompt for the whole song, revealed at the start.
2. **A turn** — two minutes by default. One player composes; everyone else
   watches their notes land live, in real time. Watchers can hit **Listen** at
   any moment to play the song-so-far for themselves — it is their own private
   playback, so nobody has to wait their turn to hear it. The composer can hand
   over early with **End my turn**.
3. **Is it done?** — after each turn everyone votes. **Unanimous** "it's done"
   finishes the song. Anything less buys another turn, so a quiet or absent
   player can never end it on everyone else's behalf. The vote window is 25
   seconds; letting it lapse means another turn.
4. **Finished** — the final track, everyone credited, and a play button.

The turn passes down the room in join order and wraps around, so with three
players and five turns the first player gets two goes. **Turns until done** is
set in the lobby (default 5, up to 12) and is the backstop: hit the cap and the
song is finished whether or not anyone agreed.

Only the player whose turn it is can edit. The server enforces that, so a
watcher's client cannot slip an edit in even if it tried.

## How it is built

- `server.js` — rooms, phases, the authoritative clock, scoring. All timing
  lives here and clients render the countdown from a server deadline, so nobody
  can buy themselves extra studio time.
- `wsserver.js` — a small RFC 6455 WebSocket implementation, so the whole thing
  runs on a bare `node server.js` with nothing installed.
- `public/audio.js` — the Web Audio synth. Drums are synthesised, not sampled.
- `public/app.js` — the client: networking, the grid editor, playback sync.

A song is just data — a few hundred bytes of grid, tempo, and timbre settings.
That is what travels between players; every browser renders the audio itself.
Nobody uploads audio, so playback starts instantly and stays in sync.

Songs arrive from clients, so the server clamps every field of an incoming song
into range before storing it. A malformed payload can't reach anyone else.

## Tests

```bash
npm test
```

Two suites, both spinning up a real server and driving two players over real
WebSockets:

- `test/flow.test.js` — clash mode: two full rounds, scoring, ordering, and
  that stale votes are ignored.
- `test/jam.test.js` — jam mode: turn rotation, live streaming to watchers,
  that a watcher cannot edit the shared song, the unanimity rule, and the
  turn cap.

## Notes and limits

- Audio needs a click before it can start — browsers require a user gesture.
  Creating or joining a room counts, so this is handled.
- There is no reconnect. If you drop out you rejoin as a new player, though your
  in-progress track is autosaved on the server every time you edit, so a blip
  during the studio phase won't lose your work.
- Rooms live in memory only and are cleaned up a minute after the last player
  leaves.
- If the host leaves, the next player in the room becomes host.
