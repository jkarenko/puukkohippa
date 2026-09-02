# Puukkohippa

A playful top-down knife tag game. Couch and online multiplayer mix freely:
one browser can host several local players on keyboards and gamepads, and
several such browsers can share one room through a small WebSocket server.

- **Puukottajat** (red hats) try to touch **runners** (yellow hats). A touched
  runner becomes a puukottaja too.
- There is exactly one throwable knife, the *puukko*. Whoever carries it moves
  at 90 % of the runners' base speed. Hold the throw button to charge (you
  stop while charging, turning still works), release to throw
  straight ahead. Tap a direction while charging to pass the knife to the
  nearest fellow puukottaja in that direction.
- A knife that is still flying converts the runner it hits. A knife lying on
  the ground is a solid obstacle for runners: throw it across a narrow corridor
  to build a trap. Any puukottaja picks it up by walking into it.
- Runners get a little faster every time someone is converted.
- The last runner standing wins the round and starts the next one as the
  puukottaja. Arenas are procedurally generated per round.

Controls are tank controls: forward/back move along your heading, left/right
turn.

## Run it

```bash
pnpm install
pnpm dev          # Vite dev server on http://localhost:5173 (couch mode)
pnpm server       # WebSocket server on ws://localhost:8787 (for online rooms)
```

- Couch play: open `http://localhost:5173/` and press a throw button on each
  keyboard layout or gamepad you want to join with.
- Online play: run `pnpm server`, then open `http://localhost:5173/?room=sauna`
  on every machine. Your own players are predicted locally, so controls feel
  instant; other players are shown about 120 ms behind. Each machine can still join several local players. Use
  `&server=ws://host:8787` to point at a server on another machine.
- Production: `pnpm build` then `pnpm start`. The Node server serves the built
  client and the WebSocket endpoint on the same port (`PORT`, default 8787).

### Local control slots

| Slot        | Forward / Back | Turn         | Throw / Join |
| ----------- | -------------- | ------------ | ------------ |
| Keyboard 1  | ↑ / ↓          | ← / →        | Space        |
| Keyboard 2  | W / S          | A / D        | E            |
| Keyboard 3  | I / K          | J / L        | O            |
| Gamepad 1–4 | Stick / D-pad  | Stick / D-pad| A or R2      |

Up to 32 players per room.

### URL parameters

| Parameter | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| `room`    | Join an online room with this name. Omit for couch mode.  |
| `server`  | WebSocket URL of the server (default: same host, port 8787 in dev). |
| `seed`    | Arena seed for couch mode, any string.                    |

## Development

```bash
pnpm test         # vitest: simulation rules, targeting, arena generation
pnpm typecheck    # client + server TypeScript
```

See [docs/DESIGN.md](docs/DESIGN.md) for the rules in detail, the
architecture, and the list of tunable constants.

## Hosting on a public server

The Node server binds to all interfaces, so on a machine with a public IP it
is reachable at `http://<ip>:8787` as soon as the port is open in the
firewall (`ufw`, plus the cloud provider's firewall if one is attached).
Run `pnpm build && pnpm start` and open `http://<ip>:8787/?room=sauna`.

Browsers only expose the Gamepad API on secure origins (HTTPS or localhost),
so gamepads will not work over plain `http://<ip>`; keyboards do. For HTTPS
without owning a domain, put Caddy in front with an sslip.io name such as
`157-180-42-208.sslip.io` and `reverse_proxy localhost:8787`; the client
picks `wss://` on the same host by itself.
