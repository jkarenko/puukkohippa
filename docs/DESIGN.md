# Puukkohippa – design notes

## Rules

| Rule | Implementation |
| --- | --- |
| Roles: puukottaja (red hat) and runner (yellow hat). | `PlayerState.role` |
| A puukottaja touching a runner converts them. | `playerInteractions` in `src/sim/sim.ts` |
| Every puukottaja has a built-in knife (touch works without the puukko). | Touch conversion does not depend on the knife. |
| Exactly one throwable puukko exists at all times. | `GameState.knife` is a single state machine: `held`, `flying`, `ground`. |
| The carrier moves at 90 % of the runners' *base* speed; the per-conversion runner bonus does not apply to the carrier. | `speedFor`; `KNIFE_CARRIER_SPEED_FACTOR`. |
| Hold throw to charge, release to throw straight ahead. Longer charge = faster and farther. | `updateThrowing`; speed is `lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, charge)`; the knife decelerates at `KNIFE_DECEL`, so range grows quadratically with speed. |
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
- Online play is server-authoritative. Clients send their local players'
  inputs (30 Hz, on change plus keepalive); the server broadcasts full state
  snapshots at 20 Hz. The client renders about 110 ms behind the newest
  snapshot and interpolates positions and headings between snapshots. There
  is no client-side prediction yet; on a LAN this feels fine, over the
  internet the tank controls will feel slightly delayed.
- Mixed couch + online: every client can register several local players
  (one per control slot). The server tracks which player ids belong to which
  socket and removes them on disconnect.
- Arenas are generated from a seed by `generateArena`, and both sides call
  the same function, so the arena is never sent over the wire. Generation
  places blocks, walls and L-shaped corner walls with a minimum corridor
  width of two player diameters, then rasterises walkability and rejects
  layouts whose largest connected region is below 97 % of the free area.
- Snapshots carry the events (conversions, throws, pickups, round changes)
  produced since the previous snapshot so the client can play effects.

## Rendering

Fixed camera, single screen, 1600 × 900 logical pixels scaled to fit the
window. Black background with a faint grid, blue-grey obstacles with a lighter
edge, players as bright oval bodies with a hat in the role colour and a visor
pointing along the heading. The knife is drawn as a handle, guard and blade;
on the ground it has a soft shadow so its blocking footprint is visible.

## Not done yet / ideas

- Client-side prediction and reconciliation for the local players (would
  make online tank controls feel instant).
- WebRTC peer-to-peer transport with one browser acting as host; the `Host`
  interface is the seam for it.
- Sounds, a proper lobby with name/colour selection, scoreboards across
  rounds, spectators.
- Bots to fill rooms.
- Delta-compressed snapshots (currently full JSON state at 20 Hz; fine for
  32 players on a LAN).
