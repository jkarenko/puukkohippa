# Puukkohippa – design notes

## Rules

| Rule | Implementation |
| --- | --- |
| Roles: puukottaja (red hat) and runner (yellow hat). | `PlayerState.role` |
| A puukottaja touching a runner converts them. | `playerInteractions` in `src/sim/sim.ts` |
| Every puukottaja has a built-in knife (touch works without the puukko). | Touch conversion does not depend on the knife. |
| Exactly one throwable puukko exists at all times. | `GameState.knife` is a single state machine: `held`, `flying`, `ground`. |
| The carrier moves at 90 % of the runners' *base* speed; the per-conversion runner bonus does not apply to the carrier. | `speedFor`; `KNIFE_CARRIER_SPEED_FACTOR`. |
| Hold throw to charge, release to throw straight ahead. Longer charge = faster and farther. Holding the button stops the carrier: movement input is ignored and they slide to a halt at `CHARGE_DECEL`; turning still works for aiming. | `updateThrowing`, `movePlayer`; speed is `lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, charge)`; the knife decelerates at `KNIFE_DECEL`, so range grows quadratically with speed. |
| Tap a direction while charging to pass to the nearest puukottaja in that direction (heading-relative 4 sectors; fall back to the puukottaja angularly closest to the sector). | `pickPassTarget` in `src/sim/targeting.ts`. A *newly pressed* direction key triggers the pass; keys that were already held when charging began keep moving the player. |
| A flying knife converts the runner it hits; the runner then holds the knife. | `updateKnife`. The thrower cannot re-catch for `KNIFE_RECATCH_DELAY`. |
| A knife on the ground is a solid obstacle for runners and is picked up by any puukottaja who touches it. | `groundKnifeInteractions`; the knife is an oriented box `KNIFE_LENGTH × KNIFE_WIDTH`. |
| Runner speed increases modestly per conversion. | `RUNNER_SPEED_BONUS_PER_CONVERSION` (6 %), capped by `RUNNER_SPEED_BONUS_CAP`. Only runners get the bonus; puukottajat without the knife move at base speed. |
| Tank controls. | Left/right rotate the heading at `TURN_RATE`; forward/back move along it (back at 75 %). |
| Round flow. | `lobby` (< 2 players) → `countdown` (3 s, puukottajat frozen) → `playing` → `roundover` (5 s) → new round with a new arena seed. The last runner converted starts the next round as puukottaja. |

Everything numeric lives in `src/sim/constants.ts`.

## Architecture

```
src/sim      pure TypeScript simulation, no Phaser, no DOM   (shared)
src/net      wire protocol + Room (sim + latest inputs)      (shared)
server/      Node + ws: rooms, 60 Hz tick, 20 Hz snapshots, serves dist/
src/client   Phaser 4: input slots, host abstraction, renderer, HUD
```

- The simulation is deterministic and fixed-step (60 Hz). Both the browser
  and the server run the *same* `Room` class; the browser runs it directly
  for couch play (`LocalHost`) and talks to the server for online play
  (`NetHost`). The scene does not know the difference.
- Online play is server-authoritative with client-side prediction for the
  client's own players. The client runs its own 60 Hz tick loop: each tick it
  samples the local inputs, sends them with a sequence number, and applies
  them immediately to a predicted copy of each local player using
  `predictLocalPlayer`, which is the sim's own movement and charge code
  (throws, conversions, pickups and body separation stay server-only). The
  server queues sequenced inputs per player and consumes exactly one per
  tick (repeating the last one if the queue runs dry, dropping the oldest if
  more than 8 pile up), so the server applies the same input sequence the
  client predicted. Snapshots (20 Hz, full state) carry the last applied
  sequence per player; on each snapshot the client discards acknowledged
  inputs, rebuilds the prediction from the authoritative state plus the
  still-pending inputs, and smooths any visual difference out over about
  60 ms (corrections above 120 px snap). The HUD shows RTT, the number of
  unacknowledged inputs and the size of the last correction.
- The knife is predicted for local players too. When prediction sees a
  local charge release it spawns the same flying knife the server will
  (`createThrow`) and flies it with the same deterministic code (`flyKnife`),
  so it leaves the hand instantly and lands where the server's lands; the
  prediction is dropped once the server shows the knife landed or caught,
  or after 1.5 s without confirmation. Walking a local puukottaja onto a
  resting knife predicts the pickup the same way. A server knife thrown by
  a local player is shown advanced to the present rather than 117 ms behind,
  so it lines up with the predicted thrower; remote throws stay on the
  interpolated timeline, which matches the remote players they interact with.
- Clock control (time dilation, the Overwatch approach). Every snapshot
  reports how many of the client's inputs the server still has queued. The
  client runs its 60 Hz tick clock up to 10 % faster or slower to hold that
  depth at a target of measured jitter plus one tick (2 to 8 ticks). A
  buffer that runs dry makes the server repeat the last input, which is a
  guaranteed correction; a buffer that is too deep is pure input latency.
  The server-side queue cap is 30 inputs (500 ms). A stalled frame is capped
  at 100 ms of catch-up so the client never bursts a pile of ticks, and
  snapshots that piled up during a local stall are excluded from the jitter
  estimate.
- Remote players and the flying knife are interpolated between snapshots on
  a server-tick timeline. The clock relation is taken from the *fastest*
  snapshots in a 2 s window (the minimum of arrival time minus tick time),
  so a burst of late packets does not drag the timeline; jitter is the 90th
  percentile above that minimum. The render delay is one snapshot interval
  plus jitter plus one tick (5 to 18 ticks, 83 to 300 ms), adapting to the
  connection, and the render clock only slews by rate (2 % of real time, 20 %
  when far off) instead of jumping. The HUD shows jitter, buffer depth versus
  target, clock rate and interpolation delay.
- `?netsim=delay,jitter` (ms) adds order-preserving artificial latency to
  the client for testing; the bench harness in the scratchpad measures
  correction sizes under lag, jitter and frame stalls.
- Mixed couch + online: every client can register several local players
  (one per control slot). Ownership is per *session* (a random id kept in
  the tab's `sessionStorage`), not per socket: a reconnect with the same
  session id gets the same players and ids back. When a socket drops, its
  players stay for a 10 s grace period marked `connected: false` (drawn
  dimmed and "(offline)"), stand still, drop the knife and cannot pick it up
  or send input; after the grace period they are removed. The server pings
  every socket every 5 s and terminates one that misses a pong, so a
  vanished client (sleeping laptop, dead wifi) enters the grace period within
  about 10 s instead of hours. A second tab opening the same session
  replaces the first, which stops reconnecting rather than fighting back.
  Clean page unloads still close the socket immediately.
- Arenas are generated from a seed by `generateArena`, and both sides call
  the same function, so the arena is never sent over the wire. Generation
  places blocks, walls and L-shaped corner walls with a minimum corridor
  width of two player diameters, then rasterises walkability and rejects
  layouts whose largest connected region is below 97 % of the free area.
- Snapshots carry the events (conversions, throws, pickups, round changes)
  produced since the previous snapshot so the client can play effects.
- Snapshots are delta-encoded (`src/net/delta.ts`). The server keeps the
  last 3 s of sent snapshots per room; each client acknowledges the last
  tick it applied and receives only the fields that changed since that
  baseline (new players whole, removals by id, the knife when it changed).
  A client whose baseline has expired gets a full snapshot. Idle players cost
  about 10 bytes per snapshot instead of 200.
- Lag compensation. Every input message carries the server tick the
  client's remote view was rendered at. The room records player positions
  for the last 64 ticks; when a puukottaja's touch or a thrown knife's hit
  is checked, the target is taken from where the attacker saw it (at most
  500 ms back). Players of the same session (couch co-players) are never
  rewound against each other because the client predicts them live.
- Extrapolation. When the render tick runs past the newest snapshot,
  remote players continue along their heading at their last speed for up to
  6 ticks (with wall resolution) and a remote flying knife keeps flying, so
  a late snapshot causes drift-and-correct rather than a freeze.
- Server hygiene: 4 kB max message, a 150 messages/s token bucket per
  socket (flooders are closed), 32 sockets per IP, 64 rooms, sanitized room,
  session and player names, at most 8 inputs per message. Sessions that
  press nothing for 60 s in the lobby or 3 min in a round are removed. Each
  room logs a stats line every 10 s (tick, phase, players, kB/s out, delta
  vs full counts, tick overruns, input queue depth per player) and
  `GET /stats` returns the same as JSON.

## Rendering

Fixed camera, single screen, 1600 × 900 logical pixels scaled to fit the
window. Black background with a faint grid, blue-grey obstacles with a lighter
edge, players as bright oval bodies with a hat in the role colour and a visor
pointing along the heading. The knife is drawn as a handle, guard and blade;
on the ground it has a soft shadow so its blocking footprint is visible.

## Not done yet / ideas

- WebRTC peer-to-peer transport with one browser acting as host; the `Host`
  interface is the seam for it.
- Sounds, a proper lobby with name/colour selection, scoreboards across
  rounds, spectators.
- Bots to fill rooms.
- Binary snapshot encoding (deltas are still JSON).
- WebRTC unreliable data channels instead of WebSocket/TCP. Over lossy wifi
  a single lost packet stalls every later message until it is retransmitted
  (head-of-line blocking); UDP-style transport with redundant input packets
  is what Overwatch and most shooters use, and it is the remaining structural
  difference.
- Binary snapshot encoding (deltas are still JSON).
