# Wheel of Shame: Refinements and Next Executable Slices After First Implementation

**Iteration 3 of 10** (sequential after code changes from iter2)  
Author: (writer subagent)  
Date: 2026-06-15  
Status: Draft for review

## Iteration Context
This is iteration 3 of the planned 10 sequential iterations. Iteration 2 (as documented in design-docs/iteration-2-implement-core.md) delivered the first real slices: Participant weight/visual + Action/Snapshot models (backend/src/models.rs), Store trait extensions + full impl in memory.rs (weighted spin with fallback, actions, snapshots, restore, update_props), real sqlite impl + schema migration + weighted spin (backend/src/store/sqlite.rs), ydb stubs (backend/src/store/ydb.rs), new InspectorPanel.vue (minimal glass slider + bias controls + keyboard hints), wiring in App.vue (inspectorSelected from focused/peek, handleUpdate* stubs, Cmd-Z skeleton with exact guard, component placed after list panel). All additive; old behavior (absent weight=1.0) preserved; tests green, cargo check + vue-tsc clean.

Task for iter 3: re-explore the changed files (models, store/*, App.vue, new InspectorPanel, sqlite schema) + design-docs/iteration-2-implement-core.md. Write short design doc for "refinements and next executable slices after first implementation". Cover: polish the sqlite/ydb spin to be fully consistent, add basic WS event for segment_updated, minimal useHistory stub + optimistic reconcile, feature flag integration, WheelCanvas minimal support for weight-driven angles (reuse buildWithAngles), test cases that can be run now. Include updated PR sub-slices list (what to do next in code). 50 micro-critiques on the implemented parts (does inspector feel right with existing peek/focus? does Cmd-Z guard match exactly? etc). Bottom: Key Decisions, next-task list. Write to /tmp/grok-design-doc-3-c6b475e9.md and summary.

No em-dashes used. Concrete cites from reads. English doc (Russian-friendly summary at end).

## Re-Exploration Performed (Full, 2026-06-15)
All required files re-read or grepped (plus supporting for consistency: handlers.rs, routes.rs, ws.rs, useSession.ts, WheelCanvas.vue partials around buildWheelWithAngles, types/index.ts, NameList.vue, api/client.ts, Cargo.toml, backend/tests/api.rs, infra/ydb-schema.sql, ydb participant_from_row and spin).

Key verified facts with line anchors (post-iter2 state):
- backend/src/models.rs: exact SegmentVisual (13-18), Participant with weight/ visual Option (31-33), new Action (83-89), ActionKind tagged (92-102 incl UpdateWeight/UpdateVisual/Reorder/SnapshotRestored), Snapshot (105-110). Participant::new sets None (76-77).
- backend/src/store/mod.rs: trait now has update_participant_props (62-68), append_action, list_actions, create_snapshot, get_snapshot, restore_from_snapshot (70-83). Imports models. build_store_from_env handles sqlite/ydb.
- backend/src/store/memory.rs: maps for actions/snapshots (23-24), create populates them (38-45), spin: active indices, snapshot stub (119-124), weighted via WeightedIndex + fallback uniform (128-138), update mutates, append/list/create/get/restore impls (201-245). Note: spin creates _spin_action and _before_snapshot but does not call append/create (148-156 comments).
- backend/src/store/sqlite.rs: row_to_participant reads weight/visual (38-51), init_schema creates tables + ALTERs for migration (136-194, note duplicate CREATE IF NOT + ALTER lines 190-194), list_participants SELECT omits weight/visual (234-236: "SELECT session_id, id, name, removed, removed_at, spin_order"), add/delete full, spin: full SELECT (329), weighted choice (but uses ptr::eq hack for index 351-354), UPDATE only removed/spin_order (no action/snapshot append), update_props does partial UPDATEs then reselect (415-460), append_action builds payload but list_actions always returns vec![] (488-499 stub), create/get_snapshot and restore_from_snapshot implemented (501-573, restore does DELETE+reINSERT), tests cover only old spin/reset paths (603-627).
- backend/src/store/ydb.rs: participant_from_row hardcodes weight:None/visual:None (62-63), SELECT_PARTICIPANTS misses cols (68-72), spin still uses uniform .choose (337, no Weighted), update/append/list/create/get/restore are stubs (410-432 returning err/empty/Ok(())). ydb add/delete/reset do not touch new cols.
- backend/src/ws.rs: exactly the 5 SessionEvent variants (11-29): participant_added, participants_added, participant_deleted, spin_result, session_reset. No segment_updated. Hub broadcast unchanged.
- backend/src/handlers.rs: only old 7 ops + broadcasts of the 5 events (no update_props handler, no new events).
- backend/src/routes.rs: the 7 routes only (no /props or actions paths).
- infra/ydb-schema.sql: old only (sessions + participants with no weight/visual, no actions/snapshots tables).
- frontend/src/types/index.ts: Participant extended with weight/visual (14-15), SegmentVisual (23-26), Action/ActionKind tagged union (28-44), Snapshot (46-51). Matches backend.
- frontend/src/components/InspectorPanel.vue: props selected, emits update-weight/update-visual (5-12), onWeightInput clamps 0.1-10 (16-18), adjust buttons +/-0.5 emit direct (25-31), template: glass-panel absolute right:12px bottom:80px width:260px (35,68-82), range + buttons + footer hint "Tab to focus • Enter commit" (41-63), no flag, always renders if selected.
- frontend/src/App.vue: imports Inspector (17), destructures only old from useSession (24-41, no undo yet), inspectorSelected computed from focusedId || hoverPeekId then find in active (105-109), peekId is hover ?? focused (102), handleUpdateWeight/Visual: local mutate on activeParticipants find (583-593, comments "For now just optimistic patch... TODO: call api"), onGlobalKeydown Cmd-Z at 775-784: exact `(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !isEditableTarget(e.target)` , preventDefault, console.log only for undo, shift for redo skeleton. Template: InspectorPanel placed inside .list-section after .panel (989-993), WheelCanvas receives no overrides/angles (792-801). No feature flag guards on inspector or Z path. action-dock comment still "offset for the 340px right-side panel" (908).
- frontend/src/composables/useSession.ts: no useHistory compose, no updateWeight methods, no new WS cases (199-267 switch only the original 5), active/removed computed same, optimistic only for add/remove/spin/reset.
- frontend/src/components/WheelCanvas.vue: buildWheelWithAngles(active, angles?) at 588-707 reuses for custom segAngle (649), skips <0.005, still hardcodes identityColor for mat (659), buildWheel() calls with no angles (878-881), build path always equal via sliceAngle (616). No segment-overrides prop yet. Props include participants/peek-id etc.
- frontend/src/api/client.ts: only the original 7 fns (no updateParticipantProps, no listActions etc).
- Other: no localStorage feature flags for editor in App or components. NameList still uniform oddsPct (35 in its file). Tests/api.rs use in-memory only, cover basic.
- From design-docs/iteration-2-implement-core.md: the sketches and 50-critique (51-63), PR breakdown (420-449), exact reuse symbols (onGlobalKeydown:685 etc), snapshot-before-spin granularity, default 1.0, isEditableTarget guard, 50-action bound, silent weight changes.

All additive changes confirmed present; no breakage of uniform/1-based spin_order/peek/focus paths. Drift from iter2 sketch: sqlite list SELECT incomplete, no appends in spin paths yet, ydb no weights, inspector always on, no WS new events, no flag, Cmd-Z is pure skeleton console.

## Covered Refinements (Post-First-Impl Slices)
The first slices landed the models + core engine + minimal inspector wiring. Next executable slices focus on making the implemented pieces consistent and usable behind a gate, without expanding scope.

### Polish the sqlite/ydb spin to be fully consistent
- sqlite: fix list_participants SELECT to include ", weight, visual" (cite 234) so row_to always populates; change spin picked selection to use indices like memory (avoid ptr::eq on & from clone); actually call append_action + create_snapshot (pre-spin snapshot, post-spin action with id fix) inside the tx or after; implement real deserial in list_actions (parse kind/payload); make migration ALTERs idempotent without duplicate CREATEs.
- ydb: extend SELECT_PARTICIPANTS + participant_from_row to include weight/visual (add DECLARE + columns, map Option<f32> etc); implement weighted choice inside retry tx (same WeightedIndex + fallback as memory/sqlite); implement the 6 new trait methods (update uses UPSERT/UPDATE for cols, append/list use table ops, snapshots serialize json like sqlite, restore DELETE+reUPSERT); update add_participants to UPSERT new cols too.
- Both: ensure spin_order/medal semantics + remaining count identical to memory; log non-uniform weight dist at info when used; clamp in update_props (0.1-10).
- Result: any backend via STORE_BACKEND=sqlite yields same weighted spin + props + history paths as memory; absent weight always 1.0.

### Add basic WS event for segment_updated
- In ws.rs: add variant `#[serde(rename = "segment_updated")] SegmentUpdated { participant: Participant }` (additive to the 5).
- In handlers.rs: after successful update_participant_props, broadcast SessionEvent::SegmentUpdated { participant: updated.clone() }.
- (Later: also action_logged for history, but basic one first.)
- In useSession onMessage: add case that patches the participant in local list (by id) so inspector and wheel see the change cross-client.
- No new REST yet; this pairs with the update handler (to be added in handlers/routes slice).
- Concrete: follows exact tagged union pattern (ws.rs:10-11).

### Minimal useHistory stub + optimistic reconcile
- New (or stub file) frontend/src/composables/useHistory.ts: minimal export function useHistory(...) { const actions = ref<Action[]>([]); const canUndo = computed(() => actions.value.length > 0); async function undo() { /* optimistic reverse last locally; call api.restore or compensating; push SnapshotRestored */ console.log('[history] undo stub'); } return { actions, canUndo, undo }; }
- In useSession.ts: import, const history = useHistory(...); expose undo: history.undo, actions: history.actions; in reset clear actions; add updateWeight/UpdateVisual optimistic methods (modeled on addName: temp patch + api call + reconcile); extend WS switch with 'segment_updated' case (patch participants) and future 'action_logged'.
- No full snapshot fetch yet; stub for reconcile only. Optimistic: mutate participants ref directly then let WS confirm (or revert on error).
- Wire skeleton into App: destructure undo, call from Cmd-Z (real path instead of console).

### Feature flag integration
- Use localStorage key e.g. 'wheel-editor-inspector' === '1' (or 'wheel-editor-v2' per iter2 sketch).
- In App.vue: const editorEnabled = computed(() => { try { return localStorage.getItem('wheel-editor-inspector') === '1'; } catch { return false; } }); wrap inspectorSelected usage, InspectorPanel render (v-if), and Cmd-Z body (if (!editorEnabled.value) return; ... real undo).
- In paletteCommands: conditional "Open inspector" / "Adjust bias" entries only when enabled.
- Backend: none (engine always on for tests/api); only UI surfaces gated. Document in ? sheet once ShortcutsSheet updated.
- Dev toggle: easy console or palette command to flip (for testing now).

### WheelCanvas minimal support for weight-driven angles (reuse buildWithAngles)
- Add prop e.g. segmentOverrides?: Record<string, { weight?: number; color_override?: string }> or directly :angles?: number[] for v1.
- In build path (before/inside buildWheel): if props have overrides or weights on participants, compute normalized angles = active.map(p => (p.weight ?? 1) / total * 2*PI ); pass the angles array to buildWheelWithAngles(active, computedAngles).
- Color: if override.color_override use it for getCachedMat instead of identityColor (still use identity for donut/glows per iter2 critique).
- Callers in WheelCanvas unchanged for equal case; App will compute from activeParticipants weights and pass when editor flag on.
- Reuse exactly: no change to buildWheelWithAngles body (588); only the decision at buildWheel (878) and animate paths (minimal, keep shrink logic base on count).
- Result: changing weight in inspector (even local patch) can drive live slice resize on next rebuild (trigger via watch or explicit).

### Test cases that can be run now
- Backend: cargo test (with --features sqlite): extend sqlite tests for weighted (e.g. 1.0 vs 10.0 bias, assert picked dist over 100 runs); test update_props roundtrip + list_participants sees the value; test restore_from_snapshot preserves spin_order on later medals (create 5, spin 1-3, snapshot, spin 4-5, restore pre-4, verify spin_orders 4/5 gone and next order=4).
- api.rs integration: add test using in-memory (or sqlite) that calls update then list, spins post-weight, asserts via SpinResult.
- Frontend: vitest on useSession stub (mock api, call updateWeight, assert local patch + optimistic); test for inspector emit.
- Manual runnable now: with STORE_BACKEND=sqlite, run backend, add names via UI, use browser console to set localStorage, reload, Tab to name (focus drives inspectorSelected), drag slider (local mutate shows), note no crash on build (equal still); spin still works uniform until angles wired.
- All must keep old tests passing (absent=1.0, spin_order 1-based, medals 1/2/3 only).

## 50 Micro-Critiques on the Implemented Parts
Distilled from re-exploration of the exact post-iter2 files (50 cycles in reasoning; grouped for brevity but enumerated to 50; each points at concrete code smell or interaction gap). These shape the refinements above and the updated PR list.

1. Inspector absolute right:12px bottom:80px (InspectorPanel.vue:70) inside .list-section (fixed 320px) can visually collide with .panel content or scroll.
2. inspectorSelected uses focusedId || hoverPeekId (App.vue:106) while peekId = hover ?? focused (102); slight priority inversion when both set.
3. No feature flag on InspectorPanel mount (App.vue:989) or Cmd-Z block (775); renders and logs for everyone.
4. handleUpdateWeight mutates via find on activeParticipants (which is computed, App:585); works due to reactivity but fragile if array replaced.
5. sqlite list_participants SELECT (sqlite.rs:234) omits weight/visual; list always returns defaults even after update_props.
6. In sqlite spin picked index uses ptr::eq on active[] refs (351) vs clean index map in memory (139); cross-impl inconsistency.
7. Spin paths (memory 148, sqlite 362) never call append_action or create_snapshot; history tables stay empty post-spin.
8. sqlite list_actions always returns vec![] (498); no payload/kind parse despite append building json.
9. ydb spin still .choose uniform (ydb.rs:337); no weight path despite models having the field.
10. ydb participant_from_row + SELECT consts hardcode None for weight/visual (62,68); fetches never surface bias.
11. ydb new trait methods are pure stubs (410-432); update_props errors even in tests.
12. infra/ydb-schema.sql lacks weight/visual columns + actions/snapshots tables (only old participants).
13. Cmd-Z guard uses isEditableTarget(e.target) (App:775) matching iter2 spec, but placed after palette/shortcuts checks; order ok but comment says "exact".
14. Cmd-Z body is only console.log (782); no call to any undo stub yet.
15. Inspector range @input emits on every drag (Inspector:49) vs @change for commit; live preview relies on parent mutate.
16. adjust +/- buttons emit direct without debounce (Inspector:29); rapid clicks spam handlers.
17. Inspector width 260px (82) vs list-section 320px inner and iter2 "320px glass sidebar" spec; slight mismatch.
18. No stopPropagation on inspector inputs; global keys could still leak if focus inside.
19. WheelCanvas buildWheel always equal (880); no weight-to-angles computation despite buildWithAngles reuse ready at 588.
20. App passes no angles/overrides to WheelCanvas (792); inspector changes have zero visual angle effect today.
21. useSession exposes no undo or weight methods (428-447); App destructures old set only.
22. No 'segment_updated' in WS switch (useSession:200); cross-client weight change invisible.
23. restore_from_snapshot in sqlite does full DELETE+reinsert (545); loses any future indexes or triggers.
24. Memory spin snapshot _before has action_id empty (122); never fixed before store.
25. get_snapshot in memory takes latest always (231), ignores before_action_id param.
26. Inspector "Reset color" sets to identity (Inspector:59); but weight edit does not auto-sync visual.
27. handleUpdateVisual in App mutates but never triggers WheelCanvas rebuild (no watch on visual for angles).
28. list-section has padding/margin that may push inspector absolute out of visual bounds on mobile (App:1626).
29. No clamp server-side in memory update_props (memory:192); client clamps but direct API can set 99.
30. sqlite update_props does two separate UPDATEs + final SELECT (424-459); not atomic if tx interrupted.
31. append_action in sqlite uses kind as string (478) + separate payload; deserial in list stubbed.
32. No route/handler for update props yet (routes 7 only, handlers no new fn); handles are dead code.
33. Inspector always shows even if !editor (no v-if on flag); keyboard hints visible always.
34. focusedId cleared on spin (App:483) but inspectorSelected can linger on hoverPeek during animation.
35. peek/hover/focus reuse good (per iter2 critique 8-15) but inspector at bottom:80px overlaps dock on small vh.
36. NameList oddsPct still hard 100/len (NameList:35); no weight-aware odds label yet.
37. No palette command for inspector open or "bias for focused" (paletteCommands 601-673).
38. In sqlite spin remaining calc uses active.len()-1 (360) pre-mutate; matches memory post-mutate remaining.
39. ydb add_participants UPSERT omits weight/visual (237); new rows get old schema defaults.
40. Memory create_session inserts empty vecs for actions/snapshots (38); good, but spin never pushes.
41. Inspector kbd hint "Tab to focus" (63) but Tab is handled globally in roster; no focus trap in panel.
42. Cmd-Z preventDefault fires even inside winner/recap (no extra guard like Space 768); minor leak.
43. buildWithAngles text size uses uniform sliceAngle (622) even when angles[] unequal; labels may overflow on fat slices.
44. sqlite migration runs ALTER + CREATE IF NOT every connect (190-194); idempotent but noisy on logs.
45. No test exercising WeightedIndex bias in sqlite tests (only old uniform spin 603); api.rs same.
46. handleRemove toast undo (App:576) is manual only; new weight actions have zero undo path.
47. Inspector position z-index 30 (81) vs action-dock z 5; may paint over dock buttons.
48. useWebSocket onMessage receives raw; no type guard for unknown future events like segment_updated.
49. Snapshot participants vec stores full historical including removed_at etc; good for medal restore but size grows.
50. Overall: inspector "feels right" for selection reuse but absolute pos + always-on + no flag + no angle drive makes it look like dead UI today; Cmd-Z guard matches the isEditableTarget cite exactly but does nothing executable.

These 50 are actionable; many are direct gaps between landed slice and the iter2 sketches/critiques (e.g. 5,6,7,9,11,13,20,31,33,43,45,50). Polish addresses root consistency; flags + stubs + minimal canvas make the slice testable/visible.

## Updated PR Sub-Slices List (What to Do Next in Code)
Build directly on landed iter2; keep additive, flag-gated for UI, tests passing. Order for sequential execution.

1. Polish consistency (sqlite/ydb + spin/actions):
   - backend/src/store/sqlite.rs: fix list SELECT (add weight,visual), rewrite spin pick to index-based, wire append_action + create_snapshot (pre/post), real list_actions deserial, clean migration.
   - backend/src/store/ydb.rs: extend SELECT/participant_from_row/ add for new cols, weighted spin, full impl of 6 methods (no more err/empty).
   - backend/src/store/memory.rs: actually invoke append/create in spin (fix the _ stubs).
   - backend/tests/api.rs + sqlite tests: new cases for weighted bias, restore medal preservation, list sees props.
   - infra/ydb-schema.sql: additive columns + actions/snapshots CREATEs.
   - Verify: cargo test --features sqlite, STORE_BACKEND=sqlite manual.

2. Basic WS + handlers/routes for segment props:
   - backend/src/ws.rs: add SegmentUpdated variant (and stub action_logged).
   - backend/src/handlers.rs: new update_participant_props handler (call store, broadcast segment_updated, optional action_logged).
   - backend/src/routes.rs: add PATCH or POST /participants/{pid}/props route.
   - frontend/src/api/client.ts: add updateParticipantProps.
   - Test: api.rs endpoint, ws broadcast in bench if present.

3. Minimal useHistory stub + useSession reconcile + api:
   - frontend/src/composables/useHistory.ts: new stub file with canUndo/undo skeleton + optimistic.
   - frontend/src/composables/useSession.ts: compose, expose undo + updateWeight/updateVisual optimistic (local patch + api + reconcile), add WS cases for segment_updated (and future).
   - frontend/src/api/client.ts: listActions, restoreSnapshot etc stubs.
   - vitest: mock restore semantics, medal post-undo.

4. Feature flag + WheelCanvas angles + App wiring polish:
   - frontend/src/App.vue: editorEnabled from localStorage, guard inspector render + Cmd-Z body, call real history.undo in Z, compute angles/overrides from weights, pass :segment-overrides or :angles to WheelCanvas, add palette entry conditional on flag.
   - frontend/src/components/WheelCanvas.vue: accept overrides/angles prop, in buildWheel compute from weights (normalize), pass to buildWheelWithAngles, apply color_override in mat (reuse identity fallback).
   - frontend/src/components/InspectorPanel.vue: minor (add flag comment, ensure @change for commit).
   - NameList optional: weight badge if !=1 (no behavior).
   - Guard: only surfaces when flag=1; manual test "set localStorage, reload, Tab+drag, see slice resize".

5. Glue + tests + docs:
   - Wire restore in handlers (new route + snapshot restore + SnapshotRestored event).
   - Extend ? sheet + palette for undo/inspector.
   - Run all: cargo test, vitest, manual weighted spin + Cmd-Z (console to real) + cross-client via ws.
   - Update design-docs or add note.

Subsequent from iter2 plan (timeline etc) stay later. All sub-slices keep absent=1.0, no breaking Participant shape.

## Key Decisions
- Prioritize making landed slices consistent and observable (polish + basic event + stub + flag + canvas angles) over new surfaces; "refinements" first so iter2 code is actually exercisable.
- Snapshot-restore + weighted core from iter2 stay as-is; only fill the gaps (append calls, SELECTs, ydb parity).
- Feature flag strictly client localStorage for UI only; backend always full (safe additive).
- Reuse buildWithAngles exactly; no Three changes or anim ownership shift.
- 50-critique list must be addressed in next code slices (e.g. fix list SELECT is #5, guard exact is #13).
- Tests runnable immediately on current tree + small polish; no new infra.
- Keep English doc, concrete file:line cites, no em-dashes (hyphens/commas used for pauses).

## Next-Task List (Immediate After This Doc)
- Run full re-verify: cargo check --features sqlite, cargo test --features sqlite, cd frontend; npm run type-check or vue-tsc, npm test (targeting useSession etc).
- Implement PR sub-slice 1 (polish sqlite/ydb) as first code change.
- Add the SegmentUpdated event + broadcast as sub-slice 2.
- Create minimal useHistory stub and wire flag + canvas angles.
- After changes, re-run the 50-critique filter + manual (set flag, Tab to name, drag bias, observe angles, Cmd-Z log, spin bias).
- Prepare summary + feed to iter4 (more Top10 or execution).

## References
- Re-explored: design-docs/iteration-2-implement-core.md (full), backend/src/models.rs (entire), backend/src/store/mod.rs (entire), memory.rs (entire), sqlite.rs (entire, esp 234/329/498), ydb.rs (entire, 62/337/410), backend/src/ws.rs:11-29, handlers.rs, routes.rs, frontend/src/App.vue (entire, 105/583/775/989), InspectorPanel.vue (entire), types/index.ts, useSession.ts (entire), WheelCanvas.vue (build* at 588/878), api/client.ts, infra/ydb-schema.sql, NameList.vue:35, Cargo.toml, backend/tests/api.rs.
- Exact symbols: inspectorSelected (App 105), onWeightInput clamp (Inspector 17), isEditableTarget + Cmd-Z (App 678/775), buildWheelWithAngles (Wheel 588), list_participants SELECT (sqlite 234), spin Weighted (memory 132/sqlite 349), 5 events (ws 11).
- Prior iter output: /tmp/grok-design-doc-2-4da1f6f9.md (referenced for continuity).

No em-dashes used anywhere. All references verified against 2026-06-15 workspace state via direct reads.

---

*End of design document for iteration 3/10. Directly feeds executable refinements on the iter2 landing.*

Self-rating: 8/10 (re-exploration was full with concrete line cites from required files + design-doc; 50 critiques are specific and grounded in diffs like the list SELECT omission and positioning; covers all requested topics with updated slices; one point off for not running live cargo/npm in this pass though commands allowed, and summary file written separately. Honest on limitations: no new code changes here, only the doc as tasked).