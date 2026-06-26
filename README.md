# Wheel of Shame

A collaborative 3D elimination wheel: add names, spin, and watch one get picked
(and struck off) each round, with weighted odds, history/undo, live presence, and
a keyboard-first, high-craft UI. The wheel itself is a real three.js scene
(studio lighting, bloom, a coin-drop intro, peg ticks, a hitstop landing).

```
Frontend (Vue 3 + Pinia + three.js, Vite)  <-- REST + WebSocket -->  Backend (Rust / axum)
        :5173                                                              :8080
```

## Running locally

Both services together (from the repo root):

```bash
./dev.sh                 # starts the backend (cargo run) and frontend (npm run dev)
```

Or separately:

```bash
# backend -> http://localhost:8080  (in-memory store by default)
cd backend && cargo run

# frontend -> http://localhost:5173
cd frontend && npm install && npm run dev
```

The frontend talks to `http://localhost:8080` by default; override with
`VITE_API_BASE_URL`. The backend defaults to an in-memory store (set
`STORE_BACKEND` to persist) and reads `PORT` (default `8080`).

## Build and test

```bash
# frontend
cd frontend
npm run build            # vue-tsc -b && vite build
npx vitest run           # unit tests (pure utils + engine)

# backend
cd backend
cargo test
```

## Repository layout

```
backend/        Rust/axum API: sessions, participants, spin, action log, WS broadcast
frontend/       Vue 3 SPA (see frontend/src below)
design-docs/    idea backlogs and design notes (see below)
infra/          deployment scaffolding
dev.sh          run backend + frontend together
architecture.md the target architecture + phased refactoring plan
```

Frontend source is layered (the intended one-way dependency direction):

```
utils / types  ->  engine  ->  api  ->  stores  ->  composables  ->  components  ->  App.vue
```

- **utils / engine** - pure, dependency-free, unit-tested (wheel math, identity
  colors, recap, export helpers).
- **api** - typed REST client.
- **stores** (Pinia) - `roster` (the participant roster, preview overrides,
  prevent-repeat) and `ui` (overlay flags, focus/hover, theme). The roster store
  is the single source of truth for roster state.
- **composables** - per-instance reactive logic (spin lifecycle, session/WS,
  hotkeys, command palette, exports, flame, voice, the wheel-math worker).
- **components** - presentational Vue SFCs; `WheelCanvas.vue` hosts the
  `ThreeWheelRenderer` behind the framework-agnostic `WheelRenderer` interface.
- **App.vue** - a thin orchestrator wiring the above together.

## Architecture and refactoring

The codebase is an in-progress clean architecture. Its target shape, the known
coupling issues, and a concrete phased plan to get there (modularity,
decomposition, loose coupling, single state ownership, an event-sourced action
log folded by one pure projector, and a renderer behind a headless-testable
interface) are written up in **[architecture.md](architecture.md)**, synthesized
from a 10-lens architecture review. Phase 0 of that plan is merged; the rest is
sequenced there.

A severity-ranked list of the concrete defects to fix next (the top 50, from a
13-lens code audit) is in **[recommendation.md](recommendation.md)**.

## Design docs

- [architecture.md](architecture.md) - target architecture + refactoring plan
  (Phase 0 done).
- [recommendation.md](recommendation.md) - top 50 things currently done wrong,
  severity-ranked with concrete fixes and effort.
- [design-docs/from-scratch-redesign.md](design-docs/from-scratch-redesign.md) -
  what a from-scratch rebuild would change, and the incremental path there.
- [design-docs/top-100-ideas.md](design-docs/top-100-ideas.md),
  [next-100-ideas.md](design-docs/next-100-ideas.md),
  [next-500-ideas.md](design-docs/next-500-ideas.md) - ranked, deduped idea
  backlogs (game-feel, a11y, motion, collaboration, tooling), each grounded in
  the real code.

## Notes

- The Vite preview tab can pause `requestAnimationFrame` when hidden, so the 3D
  spin animation should be verified in a visible browser, not a background tab.
- The spin outcome is decided server-side; the client animates the wheel to the
  server's pick.
