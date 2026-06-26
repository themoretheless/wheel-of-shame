# Wheel of Shame Frontend: Phased Refactoring Plan

## Theme and guiding principle

The frontend is a half-built clean architecture. The intended layering is `utils/types -> engine -> api -> stores -> composables -> components -> App`, and the redesign docs aspire to three things: a single roster store as source of truth, an event-sourced action log folded by one pure projector, and a renderer behind a framework-agnostic interface. None of the three is finished, and the gaps share one shape: **state declared in module A, surfaced through module B, written by nobody (or by a third module C bypassing the seam).** This is the exact class of bug that produced the spinning/winnerId disconnect already fixed in commit `c5a7b36`, and at least eight live instances of it remain.

We reach the from-scratch design incrementally. Phase 0 deletes dead code and moves type contracts (behavior-preserving, validated by `vue-tsc -b && vite build` + `vitest run`). Phase 1 collapses duplicate state owners into single owners (mostly behavior-preserving). Phase 2 extracts pure cores so logic becomes unit-testable (behavior-preserving). Phase 3 makes the deeper semantic changes: one event-sourcing projector, a typed wire/worker boundary, a headless renderer, and the spin lifecycle state machine (higher risk, several requiring manual or backend verification). There is no rewrite; every phase ships independently.

The single most valuable structural insight across all ten critics: **the "domain core" lies.** The server picks the winner (`useSession.doSpin -> api.spin`), so the entire client `WheelEngine.pick`/`doPick` path, `effectiveForWheel`, prevent-repeat-as-rule, and bias logic are dead. Likewise the event log is recorded in three uncoordinated places and folded by no one, and `useHistory` silently no-ops every operation because its `sessionId` closure is permanently `''`. Honesty about where decisions actually happen drives most of this plan.

## Status

Phase 0 (all 11 items) is implemented and merged to `main` (commits `fcebd6f`,
`6ea5729`): the type contracts moved into `types/`, dead code deleted, the
opentype chunk removed, the INEFFECTIVE_DYNAMIC_IMPORT warning fixed, and the
renderer's audio + haptics extracted into a `WheelAudio` collaborator. Phases 1
to 3 below are not yet started. For a severity-ranked list of concrete defects
still in the code (several beyond this structural plan: GPU resource leaks on
every rebuild, a wrong-slice spin landing under non-uniform weights, the dead
winner-reveal callback, and a Tab handler that breaks focus traversal), see
[recommendation.md](recommendation.md).

## Verified ground truth (spot-checked against source)

- `useHistory(sessionId: string)` (useHistory.ts:22) closes over a plain string. `useSession` builds it as `useHistory('')` (useSession.ts:18) and `setHistorySession` (useSession.ts:19-22) writes `(history as ...)._sessionId = id`, which **no method in useHistory reads**. Every guard is `if (!sessionId) return`, so `loadActions/undo/restoreTo/preview` permanently no-op. This is a live defect, not a smell.
- `ui.paletteOpen` / `ui.shortcutsOpen` / `ui.showTemplateGallery` (ui.ts:73-75) are dead. App binds `cmdPalette.paletteOpen` / `cmdPalette.shortcutsOpen` and `createSessionCtrl.showTemplateGallery`. `useCreateSession.ts:36` writes the dead `deps.ui.showTemplateGallery`. `ui.setFocusedId` (ui.ts:108) has zero external callers; focus is mutated raw in App.vue and useHotkeys.
- `roster.doPick` and `roster.effectiveForWheel` (roster.ts:312-332) appear only at their definitions plus the return object. No consumers.
- WheelCanvas emits `spin-complete` twice per local spin: from the `playSpin` callback (WheelCanvas.vue:65) and from the constructor-wired `onSpinComplete` (WheelCanvas.vue:75); the renderer fires `onSpinComplete` at ThreeWheelRenderer.ts:676.
- `ThreeWheelRenderer.previewOverrides` is read at line 534 but never assigned; `updateInPlace` is never called. `_otFont`/opentype is loaded (line 268) and `void`-silenced (line 200), never rendered. `opentype.js` is a real dependency (package.json:14) with a `manualChunks` rule (vite.config.ts:21).
- `PreparedSegment` is defined in WheelCanvas.vue and imported upward by `WheelRenderer.ts:12` and `ThreeWheelRenderer.ts:14`. `Command` is imported from CommandPalette.vue by `useCommandPalette.ts:2`.
- `useHistory.ts` resolves the roster store via `await import('../stores/roster')` at lines 51/74/90 while the store is already in the static graph (App.vue:40, useSession.ts:8) => INEFFECTIVE_DYNAMIC_IMPORT.
- `api.listActions`/`getSnapshot` return `any[]`/`any` (client.ts:84-91) despite `Action`/`Snapshot` existing in types/index.ts. `updateParticipantProps` uses positional optionals (client.ts:72).
- No eslint/dependency-cruiser; build is `vue-tsc -b && vite build`; tests run in `environment: 'node'` with no `@vue/test-utils`.

## Target module structure (the from-scratch shape we converge on)

```
frontend/src/
  types/
    index.ts                 # Session, Participant, Action, ActionKind, Snapshot, SpinResult
    wheel.ts                 # PreparedSegment, SegmentVisual (moved out of WheelCanvas.vue)
    commands.ts              # Command (moved out of CommandPalette.vue)
    worker.ts                # WheelWorkerRequest / WheelWorkerResponse discriminated unions

  utils/                     # pure, dep-free, vitest-covered
    wheel.ts                 # computeAngles, weightedPickIndex, filterPreventRepeat,
                             #   + computeLanding, computeSpinEnergy, easeSpin (from playSpin)
    projection.ts            # project(actions: Action[]): RosterState  -- the ONE fold
    projectSegments.ts       # projectPreparedSegments(active, angles, opts): PreparedSegment[]
    rafThrottle.ts           # generic rAF throttle (extracted from usePreview)
    actionLog.ts             # buildAction(sessionId, kind): Action  (id/timestamp factory)
    identity.ts, recap.ts, export.ts, roster.ts   # (existing)

  services/                  # app-lifetime singletons, NO Vue lifecycle hooks
    wheelMath.ts             # worker transport (computeAngles/simulate + sync fallback + dispose)
    sessionService.ts        # WS wiring, reconnect machine, recents (init once from main.ts)

  engine/
    wheelEngine.ts           # SHRUNK to angle/prep helpers only (pick/bias/simulate deleted)

  api/
    client.ts                # typed: listActions(): Promise<Action[]>, getSnapshot(): Promise<Snapshot|null>

  stores/
    roster.ts                # SOLE owner: participants, previewOverrides, preventRepeat,
                             #   lastPickedId; calls utils/projection + services/wheelMath
    ui.ts                    # SOLE owner of overlay flags, focus/hover invariant, mute
    actionLog.ts (or store)  # the ONE client action log, folded by utils/projection

  composables/               # per-instance reactive owners ONLY
    useSpin.ts               # typed deps; spin lifecycle (or promoted to a store)
    useCreateSession.ts, useComments.ts, useFlame.ts, useVoice.ts

  controllers/               # stateless effectful functions (NOT use*)
    hotkeys.ts, exporters.ts, shareAndRecap.ts, weightTools.ts

  renderers/
    WheelRenderer.ts         # interface (imports types/wheel.ts)
    ThreeWheelRenderer.ts    # thin: implements interface, composes collaborators
    HeadlessWheelRenderer.ts # test/CI default impl (no WebGL/audio/DOM)
    three/
      SceneRig.ts            # renderer, scene, camera, composer, bloom, controls, resize
      MaterialCache.ts       # geometry/material caches + dispose
      LabelFactory.ts        # canvas-texture labels, contrast ink
      WheelMeshBuilder.ts    # build / updateInPlace
      WheelAudio.ts          # WebAudio (unit-testable with fake AudioContext)
      Haptics.ts             # vibrate
      SpinAnimator.ts        # rAF loop against a WheelView port
      wheelGeometry.ts       # WHEEL_RADIUS, camera, slowmo, font URL constants

  components/                # props-down / events-up, no domain logic
    WheelCanvas.vue          # accepts injectable renderer factory; one spin-complete emit
    SessionSwitcher.vue      # owns its own outside-click; emits 'switch'
    ... (existing panels)

  App.vue                    # thin orchestrator: wires typed deps, forwards events
```

The two enforcement mechanisms that make this stick: a **dependency-cruiser config** wired into `build`/`test` forbidding `renderers -> components`, `stores -> composables`, and upward `* -> *.vue` type imports; and the **headless renderer + happy-dom test project** that lets the component/spin seam actually be exercised in CI.

---

## Phase 0 (DONE, merged): Behavior-preserving quick wins (build + tests validate everything)

All items here are confirmed-unused deletions or pure type/import moves. Validation: `npm run build` (which runs `vue-tsc -b` then `vite build`) and `npm run test`. Several also remove the INEFFECTIVE_DYNAMIC_IMPORT warning and a whole bundle chunk.

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 0.1 | Move `PreparedSegment` (+ `SegmentVisual`) into `types/wheel.ts`; point WheelRenderer.ts, ThreeWheelRenderer.ts, roster.ts, WheelCanvas.vue at it; keep a re-export from WheelCanvas.vue for prop typing | new types/wheel.ts; WheelCanvas.vue:6-14; WheelRenderer.ts:12,36; ThreeWheelRenderer.ts:14 | S | low | yes |
| 0.2 | Move `Command` into `types/commands.ts`; CommandPalette.vue and useCommandPalette.ts import from there | new types/commands.ts; useCommandPalette.ts:2; CommandPalette.vue | S | low | yes |
| 0.3 | Delete dead `paletteOpen`/`shortcutsOpen`/`showTemplateGallery` from ui store (declarations + return object) | ui.ts:73-75,137-139 | S | low | yes |
| 0.4 | Delete dead `deps.ui.showTemplateGallery = false` write and (per cohesion critic) the dead `applyTemplate` + `ui: any` dep in useCreateSession | useCreateSession.ts:36, applyTemplate, ui dep | S | low | yes |
| 0.5 | Delete `effectiveForWheel` and `doPick` from roster store (definitions + return object); confirmed zero consumers | roster.ts:312-322,325-332,339,356 | S | low | yes |
| 0.6 | Replace the three `await import('../stores/roster')` with a top-level `import { useRosterStore }` called inside each handler; kills INEFFECTIVE_DYNAMIC_IMPORT | useHistory.ts:51,74,90 | S | low | yes |
| 0.7 | Remove opentype: delete the `import opentype`, `loadFont()`, `this.loadFont()` call, `_otFont` field, the `void this._otFont`; drop `opentype.js` dep, the manualChunks branch, and types/opentype.d.ts. Removes a 170kB chunk + a runtime .ttf fetch that renders nothing | ThreeWheelRenderer.ts:13,183,200,267-274; package.json:14; vite.config.ts:21; types/opentype.d.ts | S | low | yes |
| 0.8 | Type the API history seam: `listActions(): Promise<Action[]>`, `getSnapshot(): Promise<Snapshot \| null>`; drop the now-redundant `as Action[]` / `as any[]` casts in useHistory | client.ts:84-91; useHistory.ts:30,52,75,91 | S | low | yes |
| 0.9 | Type `roster.preparedSegments` as `PreparedSegment[]` and annotate `WheelEngine.getPreparedSegments(): PreparedSegment[]`, deleting the inline anonymous return type (depends on 0.1) | roster.ts:254; wheelEngine.ts:105-133 | S | low | yes |
| 0.10 | Remove the unused `participants?: any[]` prop from WheelCanvas and the `:participants` binding in App; the wheel's only data input becomes `preparedSegments` | WheelCanvas.vue defineProps; App.vue:592 | S | low | yes |
| 0.11 | Delete dead `useRecents.ts` (zero callers, and its `otherRecents` filters a hard-coded `''` placeholder). Recents stays in useSession until Phase 1 | useRecents.ts (whole file) | S | low | yes |

Phase 0 net effect: removes one bundle chunk, one build warning, five dead state/method declarations, two upward `.vue` type imports, and tightens four `any` seams, with zero behavior change.

---

## Phase 1: Collapse duplicate owners into single owners

These eliminate the duplicate-ownership landmines. Most are behavior-preserving for the current single happy-path; the ones marked otherwise change a half-enforced invariant or a placeholder into a real one. Validation: `vue-tsc` + existing tests + targeted new store/composable unit tests.

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 1.1 | **Fix the `useHistory` no-op defect.** Change `useHistory` to take `sessionId: Ref<string>` (or a getter); replace every `if (!sessionId)` with `if (!sessionId.value)`; delete `setHistorySession` and the `_sessionId` cast; update the ref in `create()`/`load()`. This is what makes loadActions/undo/restore actually run | useHistory.ts:22-96; useSession.ts:18-22,307,332,410 | M | medium | no (fixes a defect: history ops go from no-op to functional) |
| 1.2 | **Inline preview/prevent into the roster store.** Replace `usePreventRepeat()` and `usePreview({value:null} as any, ...)` with plain refs (`preventRepeat`, `lastPickedId`, `previewOverrides`); move the rAF-throttled `setPreviewOverride` inline (using new utils/rafThrottle.ts); delete the computed proxies and the dummy `as any`. Delete usePreview.ts/usePreventRepeat.ts; `applyPreventFilter` calls `filterPreventRepeat` from utils/wheel directly | roster.ts:4-5,19-20,132-161,299-309; usePreview.ts; usePreventRepeat.ts; new utils/rafThrottle.ts | M | medium | yes |
| 1.3 | **Promote mute to one owner.** Move `isMuted` + `wheel-muted` persistence into the ui store (`muted` + `toggleMute()`); WheelCanvas reads it (prop or watch into the renderer's audio gain); delete App's `soundMuted`/`readMutedPref`/mirror assignment; useCommandPalette reads `ui.muted` | App.vue:287-298,312-315; WheelCanvas.vue:38-49; ThreeWheelRenderer.ts (mute setter); useCommandPalette.ts | M | medium | yes |
| 1.4 | **Make `setFocusedId` the only focus writer** with the symmetric invariant (`focusedId = id; if (id) hoverPeekId = null`). Replace raw `focusedId.value = ...` in App (391,411) and useHotkeys (32,43) with `ui.setFocusedId(...)`; expose `focusedId` read-only | ui.ts:87,104-110; App.vue:391,411,340; useHotkeys.ts:13,32,43 | M | medium | no (focus/hover mutual exclusion becomes fully enforced) |
| 1.5 | **Resolve presence parallel state.** Either make the template read `ui.presence` (replace the `Math.floor(Math.random()*3)+2` literal) or delete `presence` + its writer until real WS presence exists. Recommend delete-until-real | ui.ts:89-90,147; App.vue:442,707 | S | low | no (random count -> real/empty count) if kept; yes if deleted |
| 1.6 | **One recents owner.** Either keep recents in useSession and delete the dead copy (done in 0.11), or extract a single `useRecents` with a parameterized `otherRecents(currentId)` consumed by App. Pick one; do not leave the filter smeared across App | useSession.ts:32-75; App.vue:124-126 | S | low | yes |
| 1.7 | **Type the dep bags.** Replace `deps: {...: any}` with exported `Ref`/`ComputedRef` interfaces per composable (`SpinDeps`, `HotkeyDeps`, etc.); pass the typed `useRosterStore()` to useSpin instead of `roster: any` + destructured slices. Start with useSpin (smallest, already implicated in the past bug) | useSpin.ts:6-11; useHotkeys.ts; useCommandPalette.ts; useExports.ts; useCreateSession.ts; App.vue:79-84,307-348 | M | low | yes |
| 1.8 | **Type useSession's returned `history` as `UseHistory`** so App can drop all three `as UseHistory \| undefined` casts (precondition for 2.1) | useSession.ts:401; App.vue:165,534,556 | S | low | yes |

---

## Phase 2: Extract pure cores (make logic testable without a browser)

Behavior-preserving extractions that move numeric/projection logic out of Pinia refs, the god renderer, and the orchestrator into pure, vitest-covered functions. The existing `utils/wheel.ts` (39 tests) is the template. Validation: `vitest run` with new tests + `vue-tsc`.

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 2.1 | **Action factory.** Add `buildAction(sessionId, kind: ActionKind): Action` in utils/actionLog.ts owning id/timestamp construction; replace the three triplicated inline `recordAction` blocks in App and roster's `recordEvent` body | new utils/actionLog.ts; App.vue:162-175,534-542,556-564; roster.ts:28-38 | M | low | yes |
| 2.2 | **Pure prepared-segment projector.** Extract `projectPreparedSegments(active, angles, {lastPickedId, preventRepeat, colorOf})` into utils/projectSegments.ts; both `refreshPreparedSegments` (after the worker await) and the engine fallback call it, killing the duplicated `isLast`/`isPrevented` expression and the divergent inline map | roster.ts:256-282; wheelEngine.ts:105-133; new utils/projectSegments.ts | M | low | yes |
| 2.3 | **Pure spin math.** Extract `computeLanding(idx,count,dir,currentRotation,rng)`, `computeSpinEnergy(activeCount,reducedMotion,rng)`, and `easeSpin(t)` into utils/wheel.ts with injected `rng`; `playSpin` keeps only three.js/rAF wiring. Unit-test: target lands inside winner slice for all idx, delta sign matches dir, turns within bound | ThreeWheelRenderer.ts:580-603; utils/wheel.ts | M | low | yes |
| 2.4 | **Extract WheelAudio + Haptics** as standalone collaborators (injectable AudioContext) so the envelope logic is unit-testable; ThreeWheelRenderer holds one WheelAudio; mute flows through one setter | ThreeWheelRenderer.ts (audio fields + methods); new renderers/three/WheelAudio.ts, Haptics.ts | M | low | yes |
| 2.5 | **Demote stateless controllers to plain functions.** Move `useHotkeys`/`useExports`/`useVoice` to `controllers/` (or `actions/`) as typed plain functions (they own no reactive state). Convert `useExports` to `exporters.ts` taking explicit `canvas`/`participants`/`title` instead of the wheelRef bag | useHotkeys.ts, useExports.ts, useVoice.ts; App.vue call sites | M | low | yes |
| 2.6 | **Extract orchestrator clusters from App.** `useRosterEdits` (store-mutation + REST + history + undo-toast, one write path; fold the direct `p.visual = visual` into the store), `shareAndRecap.ts` (copyLink/copyRecap/copyRecapImage), `weightTools.ts` (suggestAIWeights/equalizeWeights), and presentation helpers (focusAnnounce/winnerAnnounce/liveAccent reusing `preparedSegments` angles instead of recomputing). Move SEED_TEMPLATES to `data/templates.ts` | App.vue:190-242,287-298,458-493,518-572; new composables/controllers | L | medium | partly (one write path replaces two for visual edits) |
| 2.7 | **Hoist scene constants** (WHEEL_RADIUS, camera, slowmo, font URL) into renderers/three/wheelGeometry.ts so the upcoming collaborators and the SVG export path share one source and cannot drift | ThreeWheelRenderer.ts top-of-file; new renderers/three/wheelGeometry.ts; utils/export.ts | S | low | yes |

---

## Phase 3: Deeper semantic changes (higher risk, may need manual/backend verification)

These realize the from-scratch design. They change real behavior and some cannot be fully validated by the node test env alone (the memory notes confirm the live browser/Preview path is currently unreliable, so renderer-visual changes need explicit manual checks or a headless harness first).

### 3A. One event-sourcing projector

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 3A.1 | Create `utils/projection.ts`: `project(actions: Action[]): RosterState` (`{participants, lastPickedId}`), an exhaustive `switch(kind.type)` with `assertNever`, keyed on **real** participant ids (extend `Add` payload to carry the assigned id), handling all nine ActionKind variants. Add projection.test.ts folding known action lists per kind incl. Reorder/Reset/Spin | new utils/projection.ts + test; types/index.ts (Add id) | M | medium | no |
| 3A.2 | One client action log. Delete `roster.eventLog`/`recordEvent`; route all roster mutations + App's inline records through a single sink (the `useHistory.actions` log or a small `useActionLog`). `roster.replayEvents` becomes `participants = project(actions)`; the `'replay-'+Date.now()` id fabrication goes away | roster.ts:24-61,188,369-372; useHistory.ts; App.vue:167,536,558 | L | high | no |
| 3A.3 | `roster.applyState(state)` sets participants AND lastPickedId together; `undo/restoreTo/preview` call `applyState(project(actionsUpTo))` instead of `setParticipants(snapshot)`, so time-travel restores derived state (prevent-repeat pointer) too. Collapse `applySpinResult` into append-Spin -> project -> applyState so live-apply and replay converge (removed_at/spin_order match) | useHistory.ts:52,75,91; roster.ts:228-235,271-272; useSpin.ts:27-39 | M | medium | no |
| 3A.4 | (Backend) Make `get_snapshot` a true fold over the typed action log ordered by stored `timestamp`, not lexical UUID comparison; mirror the TS projector in Rust. Required for server-authoritative time-travel to be correct at all | backend/src/store/memory.rs:237-258; handlers.rs:319,337; models.rs; client.ts:93-98 | L | high | no |
| 3A.5 | Sequence bootstrap: `await loadActions`, derive roster once from one authoritative source, then `ws.connect` so live events apply on a settled base; buffer WS messages received mid-load. Stops a concurrent `participant_added` from being wiped by the deferred `replayEvents` | useSession.ts:299-346,209-291; roster.ts:41-61,92-95 | M | high | no |

### 3B. Spin lifecycle and reactivity correctness

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 3B.1 | Collapse the double `spin-complete` emit to one channel (drop one of WheelCanvas:65 / :75; renderer fires one of `onComplete`/`onSpinComplete`). Add a test asserting exactly one emit per playSpin | WheelCanvas.vue:63-67,75; ThreeWheelRenderer.ts:663-676; useSpin.ts:27 | S | low | no (removes accidental double-resolve) |
| 3B.2 | Single SpinController owning one status union (`idle\|requested\|animating\|landing`) and `origin: local\|remote`; fold `suppressWsSpin` (useSession) and the non-reactive `isLocalSpin` (useSpin) into it; move `api.spin` + WS `spin_result` intake into it so local/remote converge on one `setPending`/`onLanded`. Drop the dead `onWinner`/`onDrift` renderer callbacks and the empty `onCanvasMouseMove` | useSpin.ts (all); useSession.ts:79,240-263,366-380; App.vue:371,399-412; ThreeWheelRenderer.ts callbacks | L | medium | no |
| 3B.3 | Optimistic-mutation registry keyed by temp-id with one idempotent `reconcile(serverEntity, tempId)` used by both the HTTP resolution and the WS echo; capture sessionId at call time so the 600ms rollback no-ops after a session switch | roster.ts:165-214; useSession.ts:211-233 | M | medium | no |
| 3B.4 | Reactive engine sync: replace `JSON.stringify`-keyed watch + manual `syncEngine()` calls with a watch over a stable structural signature, plus a monotonic request token in `refreshPreparedSegments` to discard stale out-of-order worker results | roster.ts:64-76,256-287; useWheelWorker.ts:73-80 | M | medium | no |

### 3C. Renderer decomposition, headless seam, services

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 3C.1 | Decide updateInPlace's fate: either delete the dead path (`previewOverrides` never assigned, never called) from renderer + interface, or wire weight-drags/preview through it. Safe step: delete | ThreeWheelRenderer.ts:49,532-559; WheelRenderer.ts | S | low | yes (delete) |
| 3C.2 | Split ThreeWheelRenderer into SceneRig / MaterialCache / LabelFactory / WheelMeshBuilder / SpinAnimator (driving a `WheelView` port) composed in the constructor; class keeps only the WheelRenderer surface | ThreeWheelRenderer.ts -> renderers/three/* | L | medium | yes (per collaborator) |
| 3C.3 | `HeadlessWheelRenderer` implementing WheelRenderer with no WebGL/audio/DOM; inject the renderer into WheelCanvas via a factory prop (default Three); promote `toggleMute/dismissWinner/resetView/captureCanvas` onto the interface to kill the `as any` reaches | new renderers/HeadlessWheelRenderer.ts; WheelRenderer.ts; WheelCanvas.vue:47,71,91-95 | M | low | no (adds a seam; default path unchanged) |
| 3C.4 | Worker transport -> `services/wheelMath.ts` (no Vue, explicit `dispose()`); remove the no-op `onBeforeUnmount`; roster imports the service. Split useSession's module-singleton WS/reconnect/recents into `services/sessionService.ts` initialized once from main.ts | useWheelWorker.ts; roster.ts:7,23; useSession.ts:10-291; main.ts | L | medium | no |
| 3C.5 | Extract SessionSwitcher.vue owning its outside-click (or a `useClickOutside`) and menu markup; App handles only the `switch` emit (hash + load), removing `onDocPointerDown` + the window listener pair + the hard-coded `.session-switcher` selector from the orchestrator | App.vue:139-155,357-363,673-701; new SessionSwitcher.vue | L | medium | no |

### 3D. Boundary enforcement and test harness (cross-cutting enablers)

| # | Item | Files | Effort | Risk | Behavior-preserving |
|---|------|-------|--------|------|---------------------|
| 3D.1 | Add dependency-cruiser (or eslint-plugin-boundaries) encoding `utils/types < engine < api < stores < composables < components < App`, forbidding `renderers -> components`, `stores -> composables`, and `* -> *.vue` type imports; wire into `build`/`test` so violations fail CI | new .dependency-cruiser.cjs; package.json | M | low | yes (config only) |
| 3D.2 | Add `@vue/test-utils` + `happy-dom` and a second vitest project for `*.component.test.ts`; with 3C.3 write a WheelCanvas mount test asserting one spin-complete per spin. Keep the fast node project for utils | vite.config.ts; package.json | M | low | yes (tooling) |
| 3D.3 | Typed worker protocol: `WheelWorkerRequest`/`WheelWorkerResponse` discriminated unions in types/worker.ts imported by both useWheelWorker/wheelMath and the worker; type `post<TReq,TRes>` and `computeAnglesAsync`/`simulateAsync` returns | types/worker.ts; useWheelWorker.ts; wheel-math.worker.ts; roster.ts | M | medium | yes |
| 3D.4 | Type the eventLog spine end to end on `Action`/`ActionKind` (folds into 3A): `recordEvent`/`replayEvents`/`project` typed, `assertNever` exhaustiveness, typed `updateParticipantProps(body: UpdateParticipantPropsBody)` mirroring the UpdateWeight/UpdateVisual kinds; reconcile the frontend-only `Comment` ActionKind variant against the backend enum | types/index.ts; client.ts:72; roster.ts; backend/src/models.rs | M | medium | mostly (Comment reconciliation may touch wire) |

### Engine honesty decision (spans 3A/3B)

The dead `WheelEngine.pick`/`doPick`/`suggestLeastRecentBias`/`equalize`/`simulate`/`reorder` cluster should be resolved explicitly, not left decorative. Recommended direction: **keep the server authoritative** and shrink the engine to the angle/preparation helpers actually used (delete the pick/bias/simulate methods, confirmed unused via grep). This collapses the three copies of pick state (engine.lastPickedId, prevent.lastPickedId, roster.setLastPicked) to one and removes tests that assert nothing real. If client-authoritative spins are ever wanted, the alternative is to route `doSpin` through a pure `decideSpin(segments, {preventRepeat, lastPickedId, rng})` and send the id to the server, but that is a larger product decision. Either way, do not keep both.

## Sequencing and risk notes

- **Phase 0 is fully parallelizable** and lands first; it is the cheapest confidence-builder and shrinks the surface (one fewer chunk, one fewer warning) that later phases reason about.
- **1.1 (useHistory fix) is a genuine behavior change** that turns dead features (undo via Cmd-Z, history restore, server-snapshot load) live. Do it early but verify undo/restore manually, because it exposes the projector correctness issues that Phase 3A fixes. Until 3A lands, restore relies on the server snapshot path, whose backend ordering bug (3A.4) means restored state can be wrong; flag this when shipping 1.1.
- **3A and 3B are the highest-risk cluster** and are mutually entangled (spin outcome is an Action; the projector must reproduce removed_at/spin_order). Sequence: 3A.1 (pure projector + tests) -> 3B.1 (single emit) -> 3A.2/3A.3 (one log, applyState) -> 3A.5 (bootstrap ordering) -> 3B.2/3B.3/3B.4. The backend fold (3A.4) gates exact server-authoritative time-travel and needs its own review.
- **3D.1 (boundary linter) is low-risk and should land right after Phase 0** so the upward-import inversions cannot silently return while the rest of the work proceeds. 3D.2/3C.3 unlock the first component/spin tests this codebase has ever had.
- Renderer-visual changes (3B.1, 3C.2) cannot be trusted via screenshots given the Preview rAF-throttling note in memory; gate them behind the headless harness (3C.3/3D.2) or an explicit manual spin check.

## What this buys

Single owner per concern (roster, ui, action log, mute, focus), one pure fold for all history/time-travel, a renderer behind an interface with a headless test default, typed seams at every boundary (API, worker, dep bags, event log), and a dependency linter that prevents the inversions from coming back. The recurring "declared here, surfaced there, written nowhere" bug class becomes impossible by construction, and the numeric heart of the app (projection, spin landing, prevent-repeat) moves from zero coverage into the existing vitest suite.
