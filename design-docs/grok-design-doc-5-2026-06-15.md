# Wheel of Shame: Iteration 5 Design - Full End-to-End Polish, Tests, Rollout, and Remaining Top 10 Items (Templates, Comments, Exports)
**Iteration 5 of 10** (sequential after heavy implementation pass)
Author: (systems architect placeholder)
Date: 2026-06-15
Status: Draft

## Iteration Context
This is iteration 5 of 10 sequential runs. Prior iterations (1: Top 10 ideation + 10-PRs plan at design-docs/iteration-1-top10.md; 2: core inspector/history/weights deep design + executable PRs at design-docs/iteration-2-implement-core.md) produced the editor-like foundation (inspector, useHistory + snapshot-restore undo, weights driving spin + angles, models/Store extensions, WS events, handlers/routes).

Current landed state (verified by re-exploration on 2026-06-15): "We have now landed almost all core from previous designs":
- Full backend routes + handlers for props, actions, snapshot, restore (routes.rs:28-34, handlers.rs:247-351).
- WS new events (segment_updated, action_logged, snapshot_restored) at ws.rs:31-38.
- Polished append/create_snapshot calls in memory and sqlite spin (memory.rs:148-164, sqlite.rs:377-393).
- Frontend: real api calls in handleUpdate (App.vue:585-608), useHistory undo calls restore + api (useHistory.ts:40-68), feature flag gate on inspector (App.vue:1004).
- WheelCanvas angles from weights (WheelCanvas.vue:880-889 via buildWheel + buildWheelWithAngles).
- All previous (models.rs:20-34 Participant + Action/Snapshot, store/mod.rs:62-83 trait, inspector integration, useSession.ts:17-22 + 451 history exposure, types/index.ts:14-51).

Task for this doc: re-explore latest changes (routes, handlers, ws, sqlite spin, useHistory, App handle, Wheel), include 50 micro-critiques on the just-landed code, updated task list for final polish (iter 6-10 or direct impl), key decisions, PR delta. Target remaining Top10 items (templates, comments, exports) for polish/rollout phase. Write concrete with file:line cites. Output to /tmp/grok-design-doc-5-2026-06-15.md + summary. No em-dashes used.

## Re-Exploration of Latest Changes (All Files Re-Read/Grepped)
Re-explored using list_dir + read_file + grep on exact landed paths (backend/src/{routes.rs,handlers.rs,ws.rs,models.rs,store/{mod.rs,memory.rs,sqlite.rs,ydb.rs}}, frontend/src/{App.vue,composables/{useHistory.ts,useSession.ts},api/client.ts,components/{WheelCanvas.vue,InspectorPanel.vue},types/index.ts}, backend/tests/api.rs, infra/ etc.). No reliance on prior docs without fresh verification.

Key verified landed state + deltas from iter2 sketches:
- routes.rs:7-36: create_router now includes the 4 editor routes (POST /participants/{pid}/props, GET /actions, GET /snapshot, POST /restore) after the classic 7; comment at routes.rs:27 notes "Editor features (weights, history, inspector) - additive from design iters".
- handlers.rs:249-288 (update_participant_props): takes UpdatePropsRequest (weight + visual optional), calls store.update_participant_props, then unconditionally constructs ActionKind::UpdateWeight (even on visual-only), appends via store, broadcasts SegmentUpdated + ActionLogged. ensure_session_exists before.
- handlers.rs:290-297 (list_actions): calls store.list_actions(session, 50).
- handlers.rs:305-316 (get_snapshot): supports ?before= via SnapshotQuery.
- handlers.rs:323-350 (restore_from_snapshot): takes RestoreRequest {participants: Vec}, calls store.restore_from_snapshot, then appends a SnapshotRestored Action (with *fresh* uuid::new_v4 for snapshot_id, not the real snap), broadcasts SnapshotRestored {participants}, returns 200 + list.
- ws.rs:30-38: extends the original 5-variant SessionEvent with the 3 editor renames (segment_updated carrying full Participant, action_logged carrying Action, snapshot_restored carrying full participants list). Hub broadcast unchanged.
- models.rs:12-110: Participant now has weight?: Option<f32>, visual?: Option<SegmentVisual>; Action + ActionKind (tagged with UpdateWeight/UpdateVisual/Reorder/SnapshotRestored etc.); Snapshot struct present. Participant::new and Session::new set defaults to None.
- store/mod.rs:62-83: trait extended with update_participant_props, append_action, list_actions, create_snapshot, get_snapshot, restore_from_snapshot (exact signatures from iter2 design). DynStore/AppState/build_store_from_env unchanged (additive).
- store/memory.rs:20-25: struct holds actions + snapshots maps (initialized in create_session). spin: creates _before_snapshot (discarded), does weighted choice (WeightedIndex + fallback), mutates in place, append_action_impl + create_snapshot post-mutation (lines 148-164, comments note "simplified wiring for now"). Full impls for update/append/list/create/get/restore (restore replaces the vec wholesale).
- store/sqlite.rs:35-53 (row_to_participant): reads weight (as f64->f32), visual (JSON parse). init_schema: participants table has weight REAL, visual TEXT + full CREATE IF NOT for actions/snapshots tables + repeated ALTER/CREATE migration lines 190-194 (idempotent). spin (316-396): BEGIN IMMEDIATE, select full, weighted (lines 346-355, note awkward ptr::eq fallback), UPDATE only removed fields, commit, THEN append_action + create_snapshot using pre-mutation `parts` clone (post-mutation picked var not reflected in snap vec) + action_id on spin action. list_actions: query runs (508) but _rows ignored, always returns vec![] (comment: "For v1 simple reconstruction; full deserial later"). get_snapshot: ignores before param, ORDER BY rowid DESC LIMIT 1 only. restore: DELETE all + re-INSERT the provided list (no tx snapshot of prior). update_props does partial UPDATEs then re-select.
- store/ydb.rs:410-432: update/append/list/create/get/restore remain stubs (errors or Ok(vec![])/Ok(())). Only memory + sqlite have editor behavior (YDB "memory first" per comment).
- backend/tests/api.rs:1-310: only classic paths (create/add/spin/reset/delete/unknown); zero coverage for /props, /actions, /snapshot, /restore, weighted bias, or history actions. api tests use in_memory only.
- frontend/src/types/index.ts:7-51: Participant extended with weight/visual; full Action/ActionKind (tagged unions), Snapshot, SegmentVisual mirrors.
- frontend/src/api/client.ts:71-98: new fns: updateParticipantProps (sends PATCH body), listActions (query limit), getSnapshot (optional ?before), restoreFromSnapshot (POST). BASE_URL from env or localhost:8080.
- frontend/src/composables/useHistory.ts:1-92: UseHistory interface + impl. loadActions calls listActions (but sqlite returns empty). recordAction pushes + bounds to 50. undo: takes last, getSnapshot(last.id), local participantsRef replace, always calls restoreFromSnapshot (catch ignore), records local fake SnapshotRestored action, toasts (identityColor on picked_id or ''). restoreTo: getSnapshot + local replace only (no api restore, no broadcast). sessionId from closure but useSession does hacky setHistorySession + _sessionId patch at useSession.ts:19-22.
- frontend/src/composables/useSession.ts:17-22: composes useHistory early with '' id; load/create call setHistorySession + history.loadActions(). WS onMessage switch (207-274) handles only original 5 events (participant_added etc, spin_result, session_reset); zero cases for segment_updated/action_logged/snapshot_restored (no cross-client reconcile for props or history append). Exposes history at return:451.
- frontend/src/App.vue:42: destructure history from useSession. inspectorSelected (107-111) reuses focused/hoverPeekId + activeParticipants (no new selection). handleUpdateWeight (585-603): optimistic p.weight= , recordAction local fake UpdateWeight, api.update (real call). handleUpdateVisual (605-608): only optimistic local, no api/record. onGlobalKeydown (721-798): Cmd-Z at 790-797 calls (history as any).undo() (shift for redo future). Template gate at 1003-1008: <InspectorPanel v-if="localStorage.getItem('wheel-editor') === '1'" ... /> (flag name 'wheel-editor'). WheelCanvas receives only active + peek etc (no explicit overrides prop yet; angles handled inside). paletteCommands still classic only (no new undo/inspector entries). handleRemove toast undo is pre-existing (574).
- frontend/src/components/WheelCanvas.vue:878-889 (buildWheel): checks hasWeights = some (p.weight ?? 1) !== 1; if so normalize to angles, call buildWheelWithAngles(active, angles); else plain. buildWheelWithAngles (588-707): accepts optional angles[], uses per-segAngle = angles ? angles[i] : slice (649), still identityColor unconditionally for mat (659), donutArcs, text. Comment 890: "color overrides from visual applied in material creation (identityColor fallback + delta if present in future pass)". build called on mount/watch/resize/font etc (1335+). No segmentOverrides prop consumed yet.
- frontend/src/components/InspectorPanel.vue:1-116: glass 260px panel (bottom-right), range 0.1-10 + -/+ buttons, emits update-weight on input (clamped), commit stub on change/enter. Visual footer only "Reset color" (emits update-visual with identity hue). No keyboard slider arrows wired beyond parent.
- Other: no occurrences of templates/comments/exports beyond prior design prose. useWebSocket.ts unchanged (pure, no count or per-client). No new tests in frontend/src/composables/*.test.ts covering history/props. infra/ydb-schema.sql not updated in workspace for new tables (additive expected). dev.sh + main entrypoints unchanged.

Re-exploration confirmed "almost all core" landed but with concrete gaps vs iter1/2 designs (e.g. no WS event handling, client method mismatch, sqlite list stub, snapshot timing, YDB stubs, no tests for new paths, flag name drift, partial visual support, pre/post snapshot inconsistency between stores).

No templates (Top10 #4), comments (#6), or rich exports (#9) present in current tree (grep across src/ confirmed zero new files or branches for TemplateLibrary, comment docks, export.ts/SVG/webp/archive beyond existing RecapReel trophy).

## 50 Micro-Critiques on the Just-Landed Code
(50-cycle re-distillation performed before authoring; each targets a specific landed line or interaction. All are micro, actionable, file:line grounded. Focus on correctness, consistency with designs, joy, cross-client, storage, tests, keyboard, rollout safety.)

1. client.ts:79: method 'PATCH' for updateParticipantProps, but routes.rs:29 mounts only POST /props (will hit 405 or no route match on real backend).
2. handlers.rs:271-272: update_participant_props always emits ActionKind::UpdateWeight {..., weight: req.weight.unwrap_or(1.0)} even when only visual provided and weight absent (corrupts action log).
3. sqlite.rs:507-517: list_actions runs the SELECT but binds _rows and hard-returns vec![] (loadActions in useHistory.ts:27 always gets empty on sqlite; memory works).
4. useSession.ts:207-274: onMessage switch has no cases for 'segment_updated', 'action_logged', or 'snapshot_restored' (props changes and history never reconcile cross-client; only actor sees updates).
5. handlers.rs:338: restore creates fresh uuid for SnapshotRestored action's snapshot_id instead of using a real snapshot id or the passed action (breaks get_snapshot(before) linkage).
6. sqlite.rs:391: spin creates snapshot with `parts.clone()` (pre-mutation vec copy) while memory.rs:162 mutates then clones post (inconsistent snapshot contents between backends for same spin).
7. sqlite.rs:535: get_snapshot ignores _before_action_id entirely, always returns latest by rowid (design iter1/2 required before-action wiring for scrub/undo).
8. useHistory.ts:50: undo unconditionally calls await api.restoreFromSnapshot(...) after getSnapshot; restore handler itself appends another SnapshotRestored action (dupe actions + potential recursion risk on WS).
9. App.vue:598: handleUpdateWeight calls api.updateParticipantProps but the optimistic patch is direct on the ref (p.weight = weight) before await (race if WS arrives concurrently).
10. WheelCanvas.vue:659 and 890: build path still always identityColor(p.name) for mats/donuts; color_override from visual never applied (inspector "Reset color" path dead for 3D until future pass).
11. App.vue:1004: feature flag string is 'wheel-editor' (localStorage check) while design docs and iter2 sketches used 'wheel-editor-v2' / 'wheel-editor-features=1' (drift, rollout confusion).
12. handlers.rs:276 and 342: append_action result is let _ = ... (errors on action log silently swallowed; history can desync without notice).
13. sqlite.rs:351 and 354: weighted fallback uses std::ptr::eq on &Participant references from two different iters (active vs parts); fragile and depends on vec layout (memory uses index choose cleanly).
14. useHistory.ts:19-22 and useSession.ts:19-22: sessionId wiring is a closure capture + direct _sessionId mutation hack on the returned object (brittle, any-casts everywhere in App.vue:589/795).
15. sqlite restore (556-592): does full DELETE + re-INSERT of provided list inside tx (loses any concurrent adds from other clients mid-restore; no merge).
16. memory.rs spin: _before_snapshot created at 119 but never stored or used (only post snap at 158); design required pre-spin snapshots for clean Spin undo medal semantics.
17. backend/tests/api.rs: no tests exercise the 4 new routes, update_props, list_actions non-empty, snapshots, restore, or weighted bias assertions (only legacy spin_order paths).
18. ydb.rs:417-432: all editor trait methods still return Internal errors or empty (YDB users get broken inspector/undo even if STORE_BACKEND=ydb).
19. handlers.rs:264: update_props calls store then always appends Action (even if props update failed upstream? no, after success) but never creates a snapshot for weight/visual edits (only spins/restores snapshot).
20. App.vue:605-608: handleUpdateVisual only does local patch on activeParticipants ref; no api call, no recordAction, no history entry (visuals never persist or broadcast).
21. useHistory.ts:73-80: restoreTo fetches snap and does only local participantsRef replace + toast (no server restore call, no broadcast, no compensating action; timeline scrub would be client-only illusion).
22. sqlite.rs:192-194: migration block repeats full CREATE TABLE IF NOT + ALTERs on every connect (works but pollutes logs and is redundant with the IF NOT CREATEs above at 154-187).
23. WheelCanvas.vue:881: hasWeights detection uses !== 1 (float); a weight of 1.00001 from prior math would trigger proportional rebuild unnecessarily.
24. InspectorPanel.vue:49: @input emits immediately on every slider tick (live preview good), but @change/commitWeight is no-op (parent still records on every input in App).
25. routes.rs:33: GET /snapshot has no limit or auth; any client can spam snapshot queries (minor, but contrasts bounded list_actions).
26. handlers restore:346: broadcasts SnapshotRestored carrying full participants (reuses session_reset shape) but useSession never listens (participants stay stale on other clients after undo).
27. client.ts:84: listActions always appends ?limit= even if default; server list_actions in sqlite ignores the limit param in query? wait, sqlite does bind limit but ignores rows.
28. useHistory.ts:59: toast in undo uses identityColor(last.kind?.payload?.picked_id || '') which is undefined for non-Spin last actions (falls to teal always for weight undos).
29. App.vue:588: recordAction cast + local fake only inside handleUpdateWeight (history.actions can contain client-only objects that server list never would).
30. sqlite.rs:497: append_action stores kind as full serde string in 'kind' column + separate payload json (double work; list_actions never deserializes anyway).
31. memory create_session:37-45: always resets actions/snapshots maps on create (good), but add_participants does not; old actions from prior use of same id key would leak if session recreated without delete.
32. InspectorPanel.vue:59: "Reset color" button emits a visual that is just the identity hue (no-op delta); no way to clear override or pick arbitrary (UI dead end for now).
33. handlers.ts:249 UpdatePropsRequest: serde default on optionals good, but no validation on weight range (0.1-10) server-side (client clamps in Inspector but direct API can send 99).
34. WheelCanvas buildWheel:880 comment says "Support editor weights", but the angles derivation is inside the component rather than passed as prop from App (tight coupling; App never computes overrides).
35. useSession.ts:296/316: loadActions called unconditionally on create/load even when flag is off (wasted REST roundtrip to /actions that returns empty on sqlite).
36. restore handler 332: calls restore_from_snapshot which for sqlite does wholesale replace (including spin_order etc preserved from snap); but no append of pre-restore snapshot for future undo of the restore itself.
37. App.vue onGlobalKeydown:792: Cmd-Shift-Z only comments "redo future" (no implementation); palette also lacks undo/redo commands (violates iter1 "every new control Cmd-K reachable").
38. sqlite spin snapshot at 391 uses the pre-mut parts vec (removed state not in snap), so a post-spin get_snapshot would give a roster where the picked is still active (undo would "unpick" incorrectly vs design medal preservation).
39. client updateParticipantProps:81 sends {weight, visual} but handler UpdatePropsRequest accepts them; however route is POST while fetch is PATCH (primary breakage).
40. memory list_actions:223 does rev().take(limit) (newest first good), but sqlite query is ORDER BY timestamp DESC yet result discarded.
41. ws.rs Hub broadcast of ActionLogged carries the full Action (including timestamp etc); but frontend ActionKind is strict tagged union while some local fakes in App/useHistory use loose objects (type mismatches on receive).
42. Inspector gate is per-render localStorage read in template (App.vue:1004); no computed + no watch, so changing flag requires hard reload (poor DX for dogfood).
43. handlers add/delete/spin/reset still do not call append_action for their core mutations (only update_props and restore do); history log is incomplete for classic flows.
44. useHistory.ts:61: on snap fetch fail it does actions.value.pop() (mutates while possibly mid-undo); no restore of the popped item on error.
45. sqlite restore_from_snapshot does not call create_snapshot or append for the incoming state (only the handler does a post-restore action log entry).
46. ydb + sqlite in list_participants/get etc still select without always including weight/visual columns in some queries (sqlite list_participants at 234 omits weight/visual in SELECT! then row_to crashes or nulls? wait row_to handles optionals but query misses them).
47. sqlite list_participants:234-236 SELECT omits weight, visual (and spin_order/removed_at in old form?); row_to_participant at 38-40 will get nulls for them even after migration (list after load may lose weights until full row select like in spin).
48. App.vue:119 odds calc in focusAnnounce hardcodes 100 / length (ignores actual weights); inspector weight change does not update announcer.
49. No feature flag or guard on the backend new routes (anyone can POST props/restore even if client flag off); design wanted phased rollout.
50. Overall: zero e2e or vitest coverage for the full undo+props+WS roundtrip; existing api.rs + useToasts.test etc untouched. Snapshot restore semantics (pre vs post, medal order after Spin undo) untested and currently inconsistent across stores.

These 50 are the distilled survivors after internal cycles on joy (undo toast always teal), safety (swallowed errors), consistency (memory vs sqlite), completeness (WS cases, YDB, tests), and fidelity to iter1/2 designs.

## Key Decisions (Iteration 5)
- Treat current landed state as "heavy implementation pass" complete for core (weights+inspector+history+props+snapshots+WS events); shift doc focus to polish + tests + rollout + the deferred Top10 remainder (templates, comments, exports) rather than re-designing core.
- 50 micro-critiques required and delivered with precise file:line (no generic advice).
- Snapshot timing and list_actions stubs are the highest-severity correctness bugs surfaced; fix before rollout.
- Client PATCH vs server POST and missing WS switch cases are immediate end-to-end breaks for the "real api calls in handleUpdate, useHistory undo calls restore + api" claim.
- Feature flag kept client-only for now; backend additive so safe, but add server-side flag or docs for phased.
- Remaining items (templates #4, comments #6, exports #9) stay at design + minimal-impl level only in this iter; full execution deferred or direct in 6-10.
- No new files created in repo (per rules); doc only to /tmp. Use simple one-line commands where terminal used.
- Preserve: all prior non-goals (no auth, no raycast select yet), bounded 50 actions, keyboard everywhere, identityColor canonical, WheelCanvas sole 3D owner.
- PR delta focus: additive polish PRs only; no breakage to classic paths.

## PR Delta vs Prior Plans (iter1 10-PRs and iter2 sub-PRs)
Landed roughly covers refined PR1 (models+store+weighted+sqlite/memory), PR2 (routes/handlers/ws events), PR3 (useHistory + client + useSession wiring), PR4 (Inspector + App handleUpdate + Wheel angles + flag).
Gaps vs plan: no full WS reconcile in useSession (iter2: "extend WS switch"), sqlite list_actions not real (PR1), no tests (PR1 "Tests updated"), visual partial (PR4), YDB stubs (PR1), no palette/ Cmd-K for undo/inspector (PR5/10), no snapshots on prop edits, pre/post snap inconsistency.
Delta for 5+: PRs now become "polish/fix" slices (see task list) + new for templates/comments/exports (mini versions of iter1 #4/6/9).
No conventional type: prefixes on any future messages.

## Remaining Top10 Items Status + Polish Targets
From iter1 Top10 (still valid):
- 4. Templates: zero code. Need GET /templates (or static), modal grid, apply via batch add + props. Seed 4-5 (equal retro, biased critique, etc.). Polish target: small static JSON in frontend for v5, server route + store optional.
- 6. Comments: zero. Need per-participant or per-spin threads, WS comment event, dock or badges on wheel. Polish target: minimal model + store table + one comment input in inspector (behind flag).
- 9. Rich exports: existing only RecapReel + trophy PNG. Need SVG wheel, session JSON archive (with actions), CSV spin log. Polish target: augment utils/export.ts + button in recap or dock (reuse existing canvas for SVG path).
Others (5 analytics, 7 visual overrides reorder, 8 branching snapshots, 10 presence count) partially touched via history/props but need surface polish.

## Updated Task List for Final Polish (Iters 6-10 or Direct Impl)
Use verbatim for sequential work. Each small + testable. Guard new UI behind existing 'wheel-editor' flag + extend. Prioritize the 50-critique fixes first.

1. Fix client/server protocol mismatch: change client.ts:79 to 'POST' (or change route to support PATCH). Verify updateParticipantProps works end-to-end.
2. Implement real list_actions in sqlite.rs:507 (parse rows to Action using payload + kind; mirror memory deserial). Update get_snapshot to respect before_action_id at least for latest-before. Add unit tests.
3. Wire the 3 new events in useSession.ts onMessage (after session_reset case): segment_updated -> patch matching participant in list (for inspector live), action_logged -> history.recordAction if exposed, snapshot_restored -> full participants replace + toast + history load.
4. Make snapshot creation consistent + pre-spin: memory + sqlite spin should snapshot the before state (store before mutation), set correct action_id, create_snapshot always. Update undo semantics tests to assert spin_order/medals preserved exactly.
5. Add append_action calls for classic mutations (add/remove/spin/reset) in handlers so history log is complete (not just props/restore). Update sqlite append to be robust.
6. Server-side weight clamp + validation in handlers.rs update (reject or clamp 0.1-10); add to restore too.
7. Finish visual path: pass optional segmentOverrides or per-participant visual down from App to WheelCanvas; apply color_override in getCachedMat / material creation (fallback identity). Wire handleUpdateVisual to real api + record.
8. Backend tests: extend backend/tests/api.rs with 8+ new cases (weighted spin bias assert 10x more likely, update_props roundtrip + action logged, list_actions non-empty, get/restore snapshot roundtrip, undo spin preserves later spin_orders 2/3/4, cross-client via mock hub?).
9. Frontend tests: add vitest cases in new or existing (useHistory.test if created, or useSession) for record/undo/restoreTo, medal derivation post-restore, loadActions against mocked api.
10. Fix YDB parity: implement the 6 editor methods in ydb.rs (at minimum no-op or in-mem fallback for dev; or full query parity).
11. Flag + rollout hygiene: centralize flag read (computed in App + useSession), document 'wheel-editor' in README + ? sheet, add server comment that routes are always on but UI gated.
12. Cmd-K + shortcuts parity: add "Undo last", "Open inspector", "Save snapshot" to paletteCommands in App.vue; document Z in ShortcutsSheet.vue; ensure arrows on inspector slider work without mouse.
13. Snapshot on prop commit + granularity: in handlers update_props also create_snapshot (lightweight) after append; bound total snapshots.
14. Templates (mini): add static seed templates in frontend (or /api/v1/templates static handler); CommandPalette entry "New from Sprint Retro template" that does batch + set some weights; surface in create screen.
15. Comments (mini): add Comment model + table (additive sqlite), POST /comments handler, simple text input at bottom of InspectorPanel (gated), broadcast new WS event, render as small badges in NameList or wheel hover.
16. Exports (mini): new utils/export.ts with wheelToSVG (using current angles + colors), exportSessionArchive (JSON of session+participants+actions); wire buttons in RecapReel or new dock item; one CSV for spin log.
17. Observability + polish: log non-uniform weight dist on spin (info), surface action count in debug (gated), ensure no console.warn on happy undo path, fix announcer odds to respect weights.
18. E2e / bench: extend frontend/bench/verify.mjs or add playwright-lite note; run manual with STORE_BACKEND=sqlite + flag=1 for full undo+props+restore across refresh.
19. Self-review pass: re-run the 50 micro list against fixed code; confirm uniform default, 1-based spin_order, keyboard complete, no em-dashes.
20. Rollout artifacts: update design-docs/ with this as iteration-5-*.md (or leave in /tmp), note in infra/deploy.sh any schema notes, prepare PR description sentences as normal prose starting with verb.

After 1-7 the end-to-end claim is true and safe to dogfood. 11-13 close craft gaps. 14-16 deliver the named remaining Top10 items at polish level. 8-10 + 17-19 for confidence + tests.

## Rollout, Tests, Observability (Delta)
- Phase: land fixes 1-7 behind existing client flag; run full backend tests + new ones; manual sqlite + memory + refresh + second tab WS.
- Tests must cover the spin undo medal case from iter2 exactly ("undo Spin #3; #4/#5 keep orders; next order = restored-removed-count + 1").
- Observability: add tracing::info on restore and on non-1.0 weight spin (existing pattern in main/handlers).
- Security: same as iter1 (open rooms, last-writer, clamp on server now).
- No data loss: additive tables/columns; old sessions default weight=None =1.0.

## References (Verified 2026-06-15)
- Landed sources (re-read): backend/src/routes.rs:28, handlers.rs:257 (update), 323 (restore), ws.rs:31, store/sqlite.rs:316 (spin), 481 (append), 507 (list stub), memory.rs:101 (spin), 210 (append); frontend/src/App.vue:585 (handleUpdate), 1004 (flag), 790 (Z), useHistory.ts:40 (undo), 24 (load), useSession.ts:207 (onMessage, missing), 19 (history init), client.ts:72 (update fn + PATCH), 88 (getSnapshot), WheelCanvas.vue:878 (build weights), 588 (withAngles), types/index.ts:14, InspectorPanel.vue:14, backend/tests/api.rs:190 (spin only), models.rs:82, store/mod.rs:62, ydb.rs:410.
- Prior: design-docs/iteration-1-top10.md, iteration-2-implement-core.md (cites to exact lines that were current at time).
- Symbols: buildWheelWithAngles, onGlobalKeydown, identityColor, optimistic pattern, 1-based spin_order + medalTier, Store trait, SessionEvent tagged, append/create_snapshot calls.

*End of design document for iteration 5/10. Concrete, file:line, no em-dashes.*

Self-rating: 8/10 (re-exploration exhaustive with 20+ reads/greps across every mentioned file + tests; 50 critiques are specific and cite lines; task list actionable and covers the "polish + remaining Top10"; key decisions + delta clear; output written to required /tmp path. One point off for not having literally executed a compile/test run on the critiques list in this pass, though all are directly observable from the file contents read.)