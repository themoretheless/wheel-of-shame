# Refinement Design Doc: Iteration 4 (useHistory + biased wheel + api stubs + Cmd-Z + inspector patch)

Re-explored on 2026-06-15 via list_dir + multiple read_file + grep on:
- /Users/themoretheless/Documents/Sources/wheel-of-shame/frontend/src/composables/useHistory.ts (full)
- /Users/themoretheless/Documents/Sources/wheel-of-shame/frontend/src/composables/useSession.ts (full)
- /Users/themoretheless/Documents/Sources/wheel-of-shame/frontend/src/App.vue (full + offset 1000)
- /Users/themoretheless/Documents/Sources/wheel-of-shame/frontend/src/components/WheelCanvas.vue (full targeted: buildWheel 878, buildWithAngles 588, watcher 2525, onMounted 2537)
- /Users/themoretheless/Documents/Sources/wheel-of-shame/frontend/src/api/client.ts (full)
- backend counterparts: routes.rs (full), handlers.rs (full), store/mod.rs (full), sqlite.rs (targeted spin 316, update 415, append 462, list 488, get_snapshot 516, restore 537), memory.rs (targeted spin 101, append 201, list 211 etc), models.rs (full)
- InspectorPanel.vue (full), types/index.ts (full), prior design-docs/iteration-2-implement-core.md (targeted PR plans + sketches at 432-494)
- greps for buildWheel|weight|history|undo|update_participant_props|listActions|props|flag across frontend and backend.

All citations below are from these exact reads. No assumptions; verified each line.

## What landed well
- useHistory composable created as clean extraction: frontend/src/composables/useHistory.ts:9-17 interface (actions ref, canUndo computed, canRedo ref, load/undo/restoreTo/recordAction), 19-94 impl with loadActions:24 (api.list), recordAction:34 (push+cap 50), undo:40 (optimistic prev capture + api.getSnapshot + participantsRef assign or pop fallback + local record), restoreTo:72, return 85.
- Integration points in useSession: useSession.ts:7 import, 19 const history = useHistory('', participants), 20 setHistorySession hack, 295/315 calls after set in create/load, 451 expose in return object.
- client.ts additive api: 71 comment, 72-82 updateParticipantProps (PATCH /props), 84-86 listActions, 88-91 getSnapshot (with before), 93-98 restoreFromSnapshot (POST /restore). Matches iter2 sketch.
- App.vue Z wiring: 776-782 exact meta/ctrl z guard (after isEditableTarget + palette + recents), 780-781 cast call to undo (shift branch present as stub).
- Inspector wiring (local only): App.vue:106-109 inspectorSelected computed (reuse focus/hover), 583-594 handleUpdateWeight (mutate) + handleUpdateVisual, 988-992 template <InspectorPanel :selected @update-weight @update-visual />, plus InspectorPanel.vue:14-31 emits on input/adjust, 35-65 template with range + buttons.
- WheelCanvas buildWheel change for proportional: 878-890: active filter, hasWeights some check, weights map max(0.1), total||1, angles map (w/total)*2pi, conditional buildWheelWithAngles(active, angles) vs no-arg. 
- buildWheelWithAngles supports angles: 588-707 (cursor, startAngle, rotation.z= , peg pos cos/sin(start), segAngle passed to getSegmentGeometry, donutArcs with per-start, text offset by seg/2); called from build and shrink paths.
- Backend store contracts landed: store/mod.rs:62-83 (update_participant_props, append_action, list_actions, create/get_snapshot, restore_from_snapshot), impls in memory.rs + sqlite.rs (update tx, append insert, restore delete+reinsert), schema in sqlite init 154-194 (actions/snapshots tables + alters).
- Weighted spin already consumes weight: sqlite spin 346 (weights from p.weight.unwrap_or(1)), WeightedIndex, memory 129 same. Matches "live biased slices when inspector edits".
- Types: frontend types/index.ts:14 weight?, 28-51 Action/ActionKind/Snapshot; backend models.rs:30 weight, 82-110 Action+ActionKind+Snapshot (tagged).

These pieces allow local patch + angle derivation + Cmd-Z dispatch + api surface. Existing equal-weight path untouched (build falls to sliceAngle when !hasWeights).

## Remaining gaps in the landed code
- No real backend calls for inspector yet: App.vue:585-588 handleUpdateWeight does ONLY local p.weight = , comment "For now just optimistic patch on local list (real api + history in next slices)", TODO; no api.updateParticipantProps call, no history.recordAction. Same for visual 591-593. Inspector always live in session but does nothing server side.
- list_actions returns empty: sqlite.rs:488-499 does query SELECT but binds _rows, returns Ok(vec![]); "For v1 simple... full deserial later". Memory returns list but no frontend ever calls recordAction on real changes so list stays empty. useHistory:27 assigns anyway.
- No feature flag yet: App.vue:583 comment "// Minimal inspector handlers (additive, behind flag in usage)", 987 comment "Inspector (editor mode v1)", 988-992 renders unconditionally in .session-screen. No localStorage check (cf iter2 design 415 'wheel-editor-v2', 445 guard). Cmd-Z at 776 also unguarded.
- No append in sqlite spin yet: sqlite.rs:316-377 tx reads active, does Weighted, UPDATE removed+spin_order, commit; ZERO call to append_action or create_snapshot (contrast memory 118-156 which creates _before/_spin_action but comments "real append + fix snapshot.action_id + store snapshot happens after; sketch", 157 drop, no store calls).
- useHistory sessionId never updates: useHistory.ts:19 closes over param for all fns (load 25 if(!sessionId), undo 41, restore 73, api calls 27/47/75); useSession.ts:19 passes '', 21 only writes (history as any)._sessionId (never read inside); create/load 295/315/296/316 call loadActions that early-returns.
- Inspector local patch + rebuild not wired for live: App 587 mutate only (no rebuild call, no nextTick); Wheel watcher 2525-2534 source: map id+name only (no weight), so buildWheel 878-890 (the hasWeights/angles path) never fires on weight drag. prompt claims "live biased slices in 3D when inspector edits" and "inspector live preview possible via local patch + rebuild" but code has patch without trigger.
- Cmd-Z timing/await: App 781 calls .undo() (which is async) with no await, no catch; inside key handler. undo may race with WS or spin.
- No recordAction on core paths: useSession addName/remove/doSpin/reset/apply never call history.recordAction; only undo itself sometimes does (useHistory 51-57 fake local-undo). history.actions thus never reflect real history.
- Handlers + routes absent: routes.rs:8-27 has only health/create/get/add/batch/delete/spin/reset/ws; no props PATCH, no actions, snapshot, restore. handlers.rs has zero matching fns (no ensure + store.update + broadcast + append). Client calls will throw/404 (useHistory catches to [] or warn).
- Snapshot/restore/list ignore beforeAction in places: client 88 uses ?before, useHistory passes last.id/actionId; sqlite get_snapshot 516-518 ignores _before, always "ORDER BY rowid DESC LIMIT 1"; list 489 queries but discards; append stores kind+payload but list does not reconstruct ActionKind union.
- Undo/restore not full optimistic+WS: useHistory undo/restoreTo do local participantsRef assign (bypass some useSession logic like lastSpinResult), no api for restoreFromSnapshot in undo path (restoreTo only gets snap locally), no WS broadcast of SnapshotRestored, no cross-client sync. useSession optimistic patterns (tempId for add etc) not reused.
- Shrink anim ignores weights: WheelCanvas 904 baseAngle = 2pi / count hard; 947-952 uses it for winAngle + extra; after biased spin the visual shrink mismatches the proportional segments user saw (build only after callback).
- Other wiring gaps: no new WS cases in useSession onMessage 207 (only added/removed/spin/reset); no event for props change; ydb.rs update returns "not yet" err; no append on reset/add paths in stores; canRedo always false; participantsRef: any loose; in useHistory record uses casts as any for kind.
- Gaps match prompt examples exactly; plus the closure and watcher key were not caught in the "progress" landing.

## Concrete next 4-5 executable code tasks
1. Polish append in sqlite spin (and memory): in sqlite.rs spin after UPDATE removed but before/after commit, create Action + Snapshot with current parts, call append_action + create_snapshot (fix action_id); make list_actions actually parse the _rows into Vec<Action> using serde on kind/payload (remove the vec![] return). Same for memory (call the real append/create instead of _ vars + drop). Add unit test asserting list after spin returns the Spin action.
2. Add basic handlers for /props and /restore (plus actions/snapshot): first routes.rs add four .route lines (PATCH /.../participants/{pid}/props to new handler, GET /actions, GET /snapshot, POST /restore). Then in handlers.rs implement four fns: update_props (ensure, call store.update_participant_props, broadcast e.g. participant_updated event with weight/visual, append UpdateWeight action), list_actions (store.list + json), get_snapshot (store.get + json), restore (ensure, store.restore_from_snapshot, append SnapshotRestored, broadcast). Wire in create_router. Keep additive.
3. Add flag: introduce simple guard e.g. const editorEnabled = () => localStorage.getItem('wheel-editor') === '1' (or import.meta or computed). In App.vue wrap inspector render 988, the handleUpdate* bodies, Cmd-Z undo branch 780, and any palette inspector entry behind the guard (default off). Add a one-off palette command or ?-sheet note to enable for dev. Update comments. (Follow iter2 415/445 intent.)
4. Full undo with optimistic + WS: restructure useHistory to take reactive sessionId (or ref) so setHistory works without hack and closure sees updates; in App handleUpdateWeight: do optimistic patch + api.updateParticipantProps + history.recordAction({id: uuid-ish, kind: {type:'UpdateWeight', payload:{id,weight}} as any, ...}); make undo prefer api.restoreFromSnapshot when snap, always record the SnapshotRestored, await the promise from key handler (wrap in try), push toast; add WS handler in useSession onMessage for new 'participant_props_updated' and 'snapshot_restored' (reconcile participants + actions). Expose/use canUndo for UI (e.g. title or palette).
5. Wire record + history on all paths + fix Wheel reactivity: in useSession addName/removeName/doSpin/reset/applySpinResult + new updateWeight, call history.recordAction with proper Action (after success or optimistic); also call on spin result from WS. In WheelCanvas change the watch source 2526 to include weight: map(p => p.id + ':' + p.name + ':' + (p.weight ?? 1) + (p.removed?1:0) ).join , so local patch now triggers rebuild + angles derivation for true live preview. Minor: also pass visual if it affects later.

These are small, sequential, testable (add vitest for history record after update; cargo test for spin append + list; curl the new endpoints once handlers in). Each <1 file focus + 1 test.

## 50 micro-critiques focused on the new code
1. useHistory.ts:19: sessionId param closed over permanently; useSession.ts:21 _sessionId patch is dead code, never deref'd by loadActions:25 or undo:41.
2. WheelCanvas.vue:2526: watch source string includes only id:name; weight mutation in App:587 produces identical string, buildWheel:878 never re-runs for live bias preview.
3. App.vue:587: finds and mutates via activeParticipants.value (computed:278); derived array mutation is anti-pattern vs mutating the participants ref directly.
4. App.vue:781: (history as any).undo() called without await or catch; promise rejection is silent in key handler.
5. useHistory.ts:27: api.listActions result cast to Action[] with "as"; runtime shape from client 84 may not match (list returns any[]).
6. sqlite.rs:498: list_actions executes the SELECT + LIMIT but discards rows and hard-returns vec![]; append_action 462 can succeed but list never shows.
7. sqlite.rs:375: spin tx commits without any append_action or create_snapshot call (316-377 has only the removed UPDATE).
8. routes.rs:25: last route is reset; the four client new paths (/props, /actions, /snapshot, /restore) have no entry, will 404 before handler.
9. handlers.rs: no fn bodies at all for props update / list / snapshot / restore (full file read confirms only up to reset + ws).
10. useSession.ts:19: history = useHistory('', participants) at top level of composable; '' is baked into all later closures.
11. useHistory.ts:7: useToasts() called at module scope of useHistory (works due to useToasts module state but couples init order).
12. App.vue:585: handleUpdateWeight body is pure local patch + TODO; never reaches client.ts:72 updateParticipantProps.
13. WheelCanvas.vue:904: animateSegmentShrink always computes baseAngle = 2 * pi / count; biased pre-spin slices (from 885) will visually jump on shrink.
14. useHistory.ts:50: on successful snap undo it pushes a synthetic Action with kind cast as any + id 'local-undo-'; bypasses real append path.
15. client.ts:88: getSnapshot appends ?before=... ; useHistory:47/75 passes action id, but sqlite get_snapshot:518 ignores param (always latest by rowid).
16. WheelCanvas.vue:660: donutArcs.push only inside the ! (segAngle<0.005) branch; tiny weight slices get no donut but active list still counts them.
17. useSession.ts:296/316: history.loadActions?.() after setHistory; but loadActions:25 if(!sessionId) early-returns with the closed '' .
18. App.vue:776: Cmd-Z preventDefault + call happens even when !history.canUndo (canUndo computed on actions which is empty due to gap).
19. useHistory.ts:62: fallback just actions.pop(); loses the action from history list without restoring state for weight-edit undos.
20. buildWheelWithAngles:622: text size / maxArcWidth always derive from uniform sliceAngle even when angles[] supplied for biased layout.
21. sqlite.rs:478: append_action binds a full serde json of kind to the "kind" column, plus separate payload; list never deserializes either.
22. memory.rs:156: spin creates _spin_action + _before_snapshot then drop(participants) with comment "real append... after"; no actual store call.
23. useHistory.ts:44: prevParticipants = [...participantsRef.value] shallow; later assign of mapped objs may drop transient flags present on source objs.
24. App.vue:589: comment claims "real api + history in next slices" but the iteration claims the integration landed.
25. WheelCanvas.vue:649: const segAngle = angles ? angles[i] : ... ; no length check, if caller passes mismatched angles[] will index error or NaN angles.
26. useSession.ts:21: ;(history as any)._sessionId = id  -- semicolon prefix + any cast; brittle and unused.
27. useHistory.ts:53: synthetic record in undo hardcodes kind as SnapshotRestored even for weight undos that took the pop path.
28. InspectorPanel.vue:21: commitWeight does nothing (empty); @change and enter just call no-op while @input already emitted live.
29. App.vue:106: inspectorSelected = activeParticipants...find; but after weight patch the selected ref is stale object? (but mutation visible).
30. useHistory.ts:85: return { actions, canUndo (computed), canRedo (plain ref), ... } ; types in interface 10-12 match but mixing ref/computed is odd for consumer.
31. WheelCanvas 2529: buildWheel() + pulseOddsHalo in nextTick on roster change; weight patch (no id/name change) skips this entirely.
32. sqlite.rs:489: list query orders by timestamp DESC but result is discarded; even if parsed, frontend useHistory load assigns to actions which undo treats as stack (last= [len-1]).
33. useSession.ts:451: history exposed raw (with internal fns); App only uses via any for undo, never accesses .actions or .canUndo for UI.
34. buildWheel:881 hasWeights check: (p.weight ?? 1) !== 1 ; after inspector sets exactly 1.0 the slice may flip back to uniform unintentionally.
35. useHistory undo:67 on catch re-assigns prev; but if concurrent WS update arrived, this clobbers it without merge.
36. client.ts:93: restoreFromSnapshot exists and is typed to return Participant[], but useHistory restoreTo and undo never call it (only local state + getSnapshot).
37. App.vue:780: else if ((history as any)?.undo)  -- truthy check on fn, then call; if present but throws, no handling.
38. WheelCanvas:888: else buildWheelWithAngles(active)  -- no angles, internal uniform; good for equal case, but derivation path 882 only entered on hasWeights.
39. useHistory.ts:36: if length >50 shift(); but recordAction called only from undo local path so far, cap never hit in normal use.
40. sqlite spin 348: WeightedIndex on the weights vec; when all clamped 0.1 but some edits, total calc ok, but equal-case reduction not used.
41. useSession load/create: participants.value = ... then setHistory then loadActions; but loadActions does not use the participantsRef param for init.
42. App 584: handleUpdateWeight takes weight:number but never validates 0.1-10 (inspector does, but direct calls could bypass).
43. WheelCanvas small-seg:653 segmentMeshes.push(null as any); 654 divider null; but pegMeshes/donut not appended, later for (const peg of pegMeshes) assumes alignment?
44. useHistory:21 canUndo = computed length>0; 22 canRedo=ref(false); interface declares canRedo as ReturnType<ref> while canUndo computed; inconsistent.
45. routes + handlers gap means even if record wired, updateParticipantProps in client will always reject (fetch 404 path in request 14).
46. In buildWheelWithAngles 652: cursor += segAngle even for skipped tiny; good for startAngle of next, but the null in segmentMeshes array means index i no longer = visual order strictly for external consumers.
47. Cmd-Z z handling 776 is after Tab/space/escape chains; if palette or recents open the z may still leak? (palette guard 714 returns early for most, but z check is later).
48. useHistory restoreTo 72 and undo 47 both call getSnapshot but never create or persist a new Snapshot on the client side for the restore point.
49. memory.rs append_action 201 pushes to the vec; list 211 reverses + take; but since no calls from spin/reset in the landed spin path, empty in practice.
50. Overall: the "Cmd-Z now actually calls history.undo" + "inspector live preview possible" + "WheelCanvas now derives" are only partial; the call is there but guarded by dead sessionId + empty actions + no watcher trigger, so never actually does the biased live undo in practice.

## Updated task list for continuing "делай"
(Delta from iter2 design doc 483-494 "Ready-to-Execute Sub-PRs". Prior 1-4 partial: frontend pieces of 3+4 done, but backend 2 missing, integration broken. Continue sequentially, keep additive, existing uniform/spin_order tests must pass. Guard new surfaces.)

1. (carry) Land any remaining engine polish (weighted spin + schema already in stores; verify spin_order preserved on restore paths).
2. (was PR2) Backend routes + handlers + WS events for /props + /actions + /snapshot + /restore (see concrete task 2 above). Include append_action calls from handlers. Broadcast participant_props_updated and action_logged. Update ydb stub. Test with cargo test + api.rs.
3. (fix from landed PR3) useHistory.ts + useSession.ts integration fixes: replace '' + _sessionId hack with reactive id (e.g. ref or re-create on set), wire recordAction calls from all mutators in useSession (add/remove/spin/reset/weight), make loadActions actually populate. Add vitest useHistory.test.ts for record + undo after weight.
4. (fix from landed PR4) App.vue + WheelCanvas + flag: add editor flag guard (concrete task 3), call api + record from handleUpdateWeight/Visual, fix watcher dep to include weight for rebuild (task 5), await undo, expose canUndo. Minor: update palette for inspector toggle under flag.
5. Polish append + snapshot in spin (concrete task 1): sqlite + memory, ensure list_actions returns real entries after spin, create snapshot before spin with correct action_id. Add test "spin with 3x weight, Cmd-Z, list shows Spin then SnapshotRestored".
6. Full optimistic undo + WS reconcile (concrete task 4): history uses restore api, cross-client undo works, toasts on remote restore, no clobber on concurrent.
7. Manual + auto tests: Tab to name, open inspector (flag), drag 0.1-10, see live slice angle change + donut, spin (bias verified by repeated), Cmd-Z undoes weight and spin preserving spin_order medals, refresh loads actions, no crash on tiny weights (<0.005 angle).
8. Self-review against this 50-critique list + no-emdash policy. Update prior design docs/iteration-*.md only if needed (additive note).
9. Prep delta PRs: split "integration fixes + handlers" as own reviewable before timeline work. Surface for iter5.

All steps small, one primary file each where possible. "делай" order: backend handlers first (unblocks api calls), then frontend fix + flag + polish.

## PR plan delta
From iter2 design doc (lines 417-449 "Code-level PR Breakdown", 483 "Ready-to-Execute"):
- Original envisioned PR1 (engine/models/store/weighted) largely complete in stores (memory/sqlite have the methods + weighted logic + schema).
- PR2 (backend routes/handlers/ws) was prerequisite but did not land; current state has client fns + useHistory calling non-existent endpoints.
- PR3 (useHistory + useSession + client fns) : useHistory.ts new file + client.ts + some useSession wiring landed, but broken (sessionId, no record calls, load never works); "add updateWeight optimistic" sketched in 434 not done.
- PR4 (Inspector + App wiring + Cmd-Z + Wheel angles + flag): InspectorPanel + partial App (local patch, Z call, selected) + Wheel buildWithAngles landed, but no flag (explicitly required in 445), no api/record in handlers 442, watcher not extended for weights (443 "compute proportional" done but reactivity not), "pass :segment-overrides" not present (only angles), Cmd-Z present but ineffective.
- Delta: insert "PR 2.5 / 3.5: fix the landed partials + add handlers" before original 5 (timeline). Move flag enforcement earlier (it was "guard everywhere until PR10" 418). Add explicit "append in spin + list deserial" as subtask (missed in sketches). PR order remains additive; no removal of prior items. Update the "Refined PR4" description to note that live preview requires the weight-inclusive watcher (not in original sketch). Keep "All sub-PRs additive... uniform default still pass".

This lands the editor core faster by fixing what was claimed done.

## References (verified files only)
- All re-explored paths listed at top.
- Prior: design-docs/iteration-2-implement-core.md:432 (useHistory sketch), 440 (inspector), 413 (handleUpdate optimistic+call), 445 (flag), 478 (Cmd-Z guard), 148 (spin snapshot note).
- No other files touched or invented.

End of doc. Next "делай" starts with backend handlers + sqlite polish to make the landed frontend actually talk to something.