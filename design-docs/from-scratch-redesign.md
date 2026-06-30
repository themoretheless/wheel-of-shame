# If I built this from scratch: what I'd redo, and the plan to get there

## TL;DR (honest take first)

A literal ground-up rewrite is **not** warranted. The app works, the hard parts
(the 3D renderer, the WS layer, the export pipeline, the spin physics) are done,
and a rewrite would re-introduce risk for little gain. What *is* warranted is a
targeted re-architecture of the 3-4 things that actually produced bugs this
session. Below is both halves of the question: the **ideal target architecture**
(the "from scratch" answer) and the **incremental path** to reach it from the
code that exists.

The single root cause behind the bugs found this session: **state has no single
owner, and the action log is not the source of truth.** Everything else follows
from that.

---

## What actually went wrong (evidence, not opinion)

These are concrete, from this codebase, and they're what the redesign targets:

1. **Duplicate state instances → dead controls.** `App.vue` instantiated its own
   `usePreventRepeat()` and `usePreview()` while `roster.ts` instantiated
   *separate* instances. The dock "no repeat" toggle flipped a ref the wheel
   never read; history-scrub preview wrote to a map nothing rendered. Both were
   silently dead until fixed this session. Root cause: composables that **own
   `ref` state** can be called in N places, each making a private island of
   state. There is no compiler error for "you instantiated the owner twice."

2. **Half-built event sourcing that can diverge.** `roster.ts` has both
   `recordEvent`/`replayEvents` (a client event log) **and** direct mutation of
   `participants.value`, plus `useHistory` pulling server snapshots via
   `getSnapshot`. Three overlapping notions of history that are never reconciled.
   `eventLog` is recorded but is not the thing the UI renders from, so it can
   drift from reality.

3. **`as any` as the type system.** `eventLog = ref<any[]>([])`,
   `replayEvents(actions: any[])`, `kind: any`, `recordEvent(kind: any, payload:
   any)`. There is no typed `Action` union, so the "events" are unvalidated bags
   and the reducer logic (`replayEvents`) is stringly-typed (`kind.type ===
   'Add'`).

4. **Renderer dead code and unclear contracts.** `spinSegmentIds` was declared
   and **never populated**, so the spin played *no peg ticks at all* (fixed this
   session). `updateInPlace` exists but `WheelCanvas` never calls it — every
   weight change triggers a full `build()` rebuild. `WheelCanvas` emits
   `spin-complete` **twice** (once via the `onComplete` arg, once via the
   `onSpinComplete` callback). `onCanvasMouseMove` is an empty stub;
   `_isPointerDown`/`_hoveredSeg` are tracked but `void`-ed. Symptoms of an
   imperative renderer with no enforced callback contract.

5. **No design-token layer.** Colors are inlined hex per-component (`#4ECDC4`
   appears dozens of times). The theme color picker writes `themeColor` but can't
   actually retheme, because nothing consumes a single `--accent`. There was no
   `:focus-visible` system at all (added this session as the first token).

6. **Only pure utils are tested.** 31 tests cover `wheel`, `roster` utils,
   `recap`, `toasts`, `websocket`. The store, the reducer logic, the renderer, and
   every component are untested — precisely the layers where the bugs above lived.

---

## The target architecture (the "from scratch" answer)

### 1. The action log is the single source of truth, on both ends

One discriminated union, shared in spirit with the Rust backend's action kinds:

```ts
type Action =
  | { type: 'Add'; id: string; name: string; at: string }
  | { type: 'Remove'; id: string; at: string }
  | { type: 'UpdateWeight'; id: string; weight: number; at: string }
  | { type: 'UpdateVisual'; id: string; visual: Visual; at: string }
  | { type: 'Spin'; pickedId: string; seed: number; at: string }
  | { type: 'Reset'; at: string }
  | { type: 'Comment'; participantId: string; text: string; at: string }
```

State is a **pure fold** over the log:

```ts
function project(actions: Action[]): RosterState { /* pure, no Vue, no IO */ }
```

`getSnapshot(sessionId, beforeActionId)` becomes `project(actions.slice(0, n))`
on the client — **time-travel and history preview are free and exact**, with no
second `eventLog` and no `getSnapshot` round-trip needed for preview. The server
persists and broadcasts **actions**, not result blobs; WS replays the same union.

This eliminates problem #2 (one history, not three) and #3 (typed, validated).

### 2. One store owns state; composables are stateless helpers

The Pinia store is the **only** place that holds roster `ref`s. Composables
(`usePreview`, `usePreventRepeat`, ...) become **pure functions over passed-in
state**, not owners of their own `ref`s. Then "instantiate the owner twice" is
structurally impossible — there is nothing to instantiate. This is the direct
fix for problem #1, generalized so it can't recur.

Optimistic updates get an explicit lifecycle instead of ad-hoc temp-id splicing:
each local action is appended as `pending`, reconciled (`confirmed` / `rejected`)
when the server echoes its authoritative action id. The projector renders
`confirmed + pending` so the UI is optimistic but the log stays truthful.

### 3. A pluggable renderer with a testable 2D default

Keep the `WheelRenderer` interface, but:

- Make the **2D canvas/SVG renderer the default** — cheap, deterministic,
  snapshot-testable, and the correct target for reduced-motion, low-power, and
  CI. (It also solves the "rAF paused in a hidden tab → can't verify" problem
  that blocked visual verification this whole session.)
- The **three.js renderer is lazy-loaded** behind a capability + preference check
  (WebGL present, not reduced-motion, not a low-power hint). It's already a 592kB
  chunk; this makes the heavy path opt-in.
- Define an **exact callback contract** (one `onSpinComplete`, fired once) and
  make the renderer a function of `(segments, spinState)` so it has no private
  state that can desync (kills problem #4's class).

### 4. A real design-token layer

`--surface-glass`, `--accent`, `--text`, `--focus-ring`, `--motion-scale`,
identity-color ramp — defined once, consumed everywhere. The color picker drives
`--accent` for real; high-contrast and `prefers-contrast`/`forced-colors` are
overrides on the same tokens; reduced-motion is one `--motion-scale` multiplier
instead of scattered per-component media queries. (The focus-ring token added
this session is the first brick of this.)

### 5. Module boundaries that the build enforces

```
engine/    pure spin math + projector (no Vue, no DOM, no IO)  → 100% unit-tested
store/     state ownership + optimistic lifecycle (Pinia)       → unit-tested
renderers/ WheelRenderer impls (2d default, three lazy)         → 2d snapshot-tested
ui/        Vue components, dumb-ish, talk only to the store      → component tests
```

UI never mutates engine state directly; the store is the only writer. A lint rule
(no imports from `ui/` into `engine/`, no `ref` ownership outside `store/`) keeps
it honest.

---

## The pragmatic path from here (recommended)

Do this incrementally; each step is independently shippable and green-testable.
Roughly highest-leverage first:

1. **Typed `Action` union + pure `project()`** alongside the current code. Unit
   test the projector hard. (Removes the `as any`; no behavior change yet.)
2. **Make the store the single owner.** Convert `usePreview`/`usePreventRepeat`
   to stateless helpers over store state; delete the duplicate instances. (This
   session did the App-side half by routing through the store; finish it by
   removing the composables' private `ref`s so it can't regress.)
3. **Flip history to fold the log.** `HistoryTimeline` preview/restore call
   `project(actions.slice(0,n))` instead of `getSnapshot`; retire `eventLog` as a
   parallel truth. Time-travel becomes exact and offline-capable.
4. **Optimistic lifecycle.** Replace temp-id splicing in `addName` with the
   pending/confirmed reconciliation.
5. **2D fallback renderer.** Ship it as the reduced-motion/low-power path first
   (low risk, additive), then make it the CI/test default; three.js stays for the
   full experience. Fix the double-emit and wire `updateInPlace` (or the
   Magic-Move tween, idea #58) so weight edits stop full-rebuilding.
6. **Tokenize CSS.** Extract inlined hex to tokens; point the color picker at
   `--accent`; fold high-contrast + reduced-motion into the token layer.
7. **Test the new seams.** Projector + selectors (pure), 2D renderer (snapshot),
   dock/roster/history (component). The renderer-heavy three.js path stays thin.

### What I would deliberately NOT change

- The spin physics / easing / slow-mo feel — it's good and hard-won.
- The Rust/axum backend shape — `getSnapshot(beforeActionId)` is already an
  event-sourced projection; the change is making the *frontend* trust it, not
  rebuilding the server.
- The export pipeline, WS reconnect/toast UX, the flame header — all fine.

---

## Why this ordering

Steps 1-3 attack the **root cause** (no single source of truth) and would have
made every bug found this session a compile error or impossible by construction.
Steps 4-7 are quality/testability that compounds but isn't load-bearing. None of
it requires a rewrite, and every step keeps the tree green — which matters
because the 3D path can't be visually verified in this environment, so
*structural* correctness (types + a pure, tested reducer + a testable 2D renderer)
is the only verification that actually holds.
