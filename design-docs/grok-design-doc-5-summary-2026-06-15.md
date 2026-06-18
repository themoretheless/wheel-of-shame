Iteration 5 design doc written to /tmp/grok-design-doc-5-2026-06-15.md.

Summary of contents:
- Full re-exploration of landed code (routes.rs:28-34, handlers.rs:257/323, ws.rs:31-38, sqlite.rs:316/385/507 (stub list_actions + pre/post snap inconsistency), memory.rs:148 (append/snap), useHistory.ts:40/50 (undo always restores + local fake), App.vue:585 (handleUpdate + local record + PATCH call), 1004 (flag), 790 (Z), useSession.ts:207 (missing new event cases), 19 (hacky sessionId), client.ts:79 (PATCH mismatch vs POST route), WheelCanvas.vue:880 (angles derivation) + 659 (no visual override yet), models/store files, ydb stubs, tests/api.rs (no new coverage), InspectorPanel.vue.
- Exactly 50 micro-critiques enumerated 1-50 with file:line (e.g. client PATCH/POST, sqlite list always [], no WS switch cases for segment_updated etc, snapshot pre/post drift between stores, swallowed append errors, flag name drift, incomplete appends for classic actions, YDB stubs, zero tests for new paths, restoreTo only local, etc.).
- Key decisions: core landed, focus polish/tests/rollout + templates/comments/exports; critiques are the heart; fixes before full claim.
- PR delta: landed ~PR1-4 of prior plans; current gaps are the 50 items; new slice for remaining Top10 at polish scope.
- Updated 20-item task list (1-7 critical fixes for e2e, 8-10 tests/YDB, 11-13 flag/craft, 14-16 mini templates + comments + exports, 17-19 polish + manual, 20 docs).
- Remaining Top10 status: templates/comments/exports have zero impl (only prior design); mini versions scoped in tasks 14-16.
- Concrete cites throughout; written without any em-dashes; absolute paths in this summary.

Next concrete steps (as options, per guidelines):
- Fix 1 (PATCH->POST) + fix 3 (real list_actions) then run backend tests.
- Wire missing WS cases in useSession then test two-tab undo.
- Add first 4 sqlite tests from task 8.

Self-rating for the doc work: 8/10 (exhaustive verification + 50 precise critiques + complete updated list covering the ask; minor deduction only for not running a terminal cargo test in this exact pass after writing). 

File written: /tmp/grok-design-doc-5-2026-06-15.md (main) and this summary at /tmp/grok-design-doc-5-summary-2026-06-15.md. All per user request and Claude.md rules (no praise, no em-dash, honest, concrete cites).