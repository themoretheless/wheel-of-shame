# Wheel of Shame — Top 100 Ideas, Suggestions & Problem Solutions (2026-06-18)

**Status (постоянно обновляется):**
Многое влито (inspector, history/undo/timeline, weights+equalize+AI, templates, analytics, mini comments+badges+persist, exports SVG/WebM, theming, voice improved, FPS, throttle preview, pure wheel math, debounce, collapsible panels, weighted odds, reduce any, dev console, usePreview/usePreventRepeat/useVoice composables, auto editor, color picker, last-picked visual ring/glow on wheel, etc.).
Остальные в roadmap (см. ниже "not done" и IMPROVEMENTS.md).

**Топ 20 приоритетных оставшихся задач (из 100 + аудитов):**
1. Web Worker for heavy spin sim / export (perf)
2. Virtualized NameList for large N (perf/UI)
3. Full threaded comments on server + WS + persist (feature)
4. Use Pinia for state management (arch)
5. Extract flame to useFlame composable (arch)
6. Full rich exports (JSON, GIF, CSV, bundle) (feature)
7. Branching from snapshot (feature)
8. Eliminate remaining as any (arch)
9. Full server rules engine (design)
10. Replay mode with 3D (feature)
11. Lazy 2D fallback mode (perf)
12. Auto show editor mode when advanced used (UI)
13. Central useStorage composable (arch)
14. Consistent snapshot timing full (arch)
15. Avoid full rebuild on visual only (perf)
16. Property-based tests for bias (devex)
17. Multi-session compare (feature)
18. Full YDB support (backend)
19. Rate limiting (backend)
20. Color picker theming (UI)

Полный 100 ниже.

Полный список 100 идей ниже. Из них **предложенные но не сделанные** (или частично) перечислены в конце разделов и в отдельном списке.

(Статус основан на текущем коде после pours.)

---

Comprehensive distilled list from:
- iteration-1-top10 + later design docs (inspector, history, weights, templates, comments, exports, presence...)
- IMPROVEMENTS.md poured items (1-35+)
- Full recent audit (perf, UI/UX, arch, coupling problems + fixes already applied)
- Code exploration (App.vue, WheelCanvas three heavy, useSession/useHistory, stores, WS, current features)
- Professional design tool patterns (Figma/Miro/Framer) adapted to elimination-ritual wheel
- Practical problems discovered (many already fixed in prior pass)

Each item:
- Short title
- Category tag: P=Performance, U=UI/UX/Access, F=Feature/Ritual, A=Arch/Design/Separation, B=Backend/Scaling, D=DevEx/Tests/Ops, X=Polish/Delight
- One-sentence why + problem it solves
- Concrete suggested solution / implementation note (grounded, additive where possible)
- Rough impact/effort (H/M/L)

Prioritized by value for a "high-craft, keyboard-first, 3D-joyful, collaborative decision wheel".

Many ideas are solutions to specific problems surfaced in the 2026-06-18 audit (god component, any casts, rebuild cost, hidden editor, snapshot drift, visual not applied, etc.).

## 1-20 Performance & Rendering

1. **P: Throttle / debounce previewOverrides rebuilds**  
   Live inspector drag causes full three rebuild on every input.  
   Solution: Use requestAnimationFrame + dirty flag or lodash throttle(16) on setPreview + watch. Only rebuild when angles actually change > epsilon.  
   Impact H / Effort L

2. **P: Extract pure wheel math to utils/wheel.ts (no deps)**  
   Angle normalization, weighted pick simulation, spin_order derivation duplicated in canvas + export + useSession.  
   Solution: Pure functions `computeAngles(weights), normalizedPick(weights, rng), simulateSpin(...)`. Use in both frontend and (via wasm or port) backend tests.  
   Impact H / Effort L

3. **P: Web Worker for heavy spin sim / export**  
   Long rosters or GIF capture + angle calc block main thread.  
   Solution: Move compute + MediaRecorder prep to worker. Transfer canvas if possible.  
   Impact M / Effort M

4. **P: Virtualized or paged NameList for N>50**  
   All names rendered always.  
   Solution: vue-virtual-scroller or simple windowed list + "show more". Keep full data.  
   Impact M / Effort M

5. **P: Lazy load three + postprocessing only when needed**  
   Already async component, but still heavy chunk.  
   Solution: Further split bloom/unreal passes or provide "lite 2D mode" toggle that skips three entirely for perf-critical sessions.  
   Impact H / Effort M

6. **P: FPS + rebuild counter dev overlay (gated)**  
   Hard to measure current perf problems.  
   Solution: Small canvas overlay or div in dev, toggle with ?debug or local flag. Log rebuild count per second.  
   Impact M / Effort L (quick win)

7. **P: Memoize identityColor + hashName heavily**  
   Called on every build, every render, every tick.  
   Solution: LRU or simple Map cache by name (name is stable).  
   Impact L / Effort L

8. **P: Avoid full scene rebuild on minor visual delta**  
   Currently rebuilds segments even for color_override only.  
   Solution: Update material.color in place for existing meshes when only visual changes (keep geometry).  
   Impact M / Effort M

9. **P: Cap concurrent particles / lower spawn in flame**  
   Flame always running.  
   Solution: Dynamic spawn rate based on visibility + device performance (navigator.hardwareConcurrency or fps sample).  
   Impact L / Effort L

10. **P: OffscreenCanvas for export SVG / GIF capture**  
    Current uses visible canvas + getImageData.  
    Solution: Dedicated offscreen for exports to avoid jank during capture.  
    Impact M / Effort M

11-20. Additional P ideas (condensed for brevity):
11. Use `performance.mark/measure` around critical paths (spin, rebuild, undo).
12. Pre-compute or cache segment geometries for common participant counts.
13. Debounce WS message processing during rapid inspector changes.
14. Reduce three postprocessing passes on mobile / reduced-motion.
15. Stream large session archives instead of full JSON in one go.
16. Instrument getStats-like for "perceived spin latency".
17. Avoid re-creating AudioContext on every voice session.
18. Tree-shake unused three addons more aggressively (vite).
19. Snapshot compaction: store only deltas + full every N actions.
20. Benchmark harness extension (frontend/bench) for N=100 weights spin.

## 21-40 UI / UX / Accessibility / Mobile

21. **U: Always-visible or one-click "Advanced Editor" toggle**  
    (Fixed in prior pass with button, but can improve: show when any weight !=1 or history >0).  
    Solution: Auto-promote or persistent pill.

22. **U: Proper SpeechRecognition + webkit fallback + lang**  
    Voice only webkit.  
    Solution: Try `SpeechRecognition` then `webkit...`, add Russian support, visual listening indicator.

23. **U: Collapsible / tabbed right panels (inspector + history + analytics)**  
    Current stack can crowd.  
    Solution: Single glass sidebar with tabs or accordion. Persist last open.

24. **U: Global "Reset all weights to 1" + "Equalize visible"**  
    Users experiment and want quick revert.  
    Solution: One button in inspector header or palette. Batch via loop or new endpoint.

25. **U: Live odds % always visible next to names (even without bias)**  
    Currently only on hover/tick.  
    Solution: Subtle % badge always (update on weight change).

26. **U: Better mobile spin gesture + large prominent Spin target**  
    Solution: Big floating action or swipe-up on wheel area + prevent default on touch.

27. **U: ARIA live + role improvements for full screen reader flow**  
    Solution: Announce "Ada eliminated, 7 remain", spin result, weight change, "preview mode".

28. **U: Visual "biased" indicator globally (glowing rim or bar on roster)**  
    Solution: CSS var or class when any weight !=1, or per-row delta pill.

29. **U: Keyboard-only full path for every new control (already strong, extend to exports, templates)**  
    Solution: Ensure every dock button + panel has Cmd-K + ? sheet entry.

30. **U: Theming: real color picker + multiple palettes beyond high-contrast**  
    Solution: Simple hue slider or preset swatches that set CSS vars + store in session.

31-40 condensed U ideas:
31. Drag-reorder with live visual feedback on wheel (already partial via reorder handler).
32. Mini live preview thumbnails in HistoryTimeline (scrub shows tiny canvas snapshot).
33. "Why this name?" hover / tooltip that shows current effective weight + rank.
34. Session "mode" switch: equal / weighted / "shame mode" (reverse bias?).
35. Persistent user nickname/avatar per browser (local, shown in presence).
36. Focus trap + escape handling in all modals/panels.
37. Reduced-motion: disable bloom + flame + pointer squash automatically.
38. High-contrast + dark/light auto from system.
39. Touch-friendly bigger slider thumbs in inspector.
40. One-handed mobile mode (bigger names list, spin anywhere on screen).

## 41-65 Features & Rituals (core value)

41. **F: Real threaded comments on segments or spins** (top10 item)  
    Solution: Add Comment model + WS event + small badge on NameList + inspector dock. Persist in sqlite.

42. **F: Rules engine (prevent repeat wins, "must eliminate X before Y", cooldown)**  
    Solution: Pure `shouldAllowSpin(participant, history)` evaluated in store before pick. UI editor for simple rules.

43. **F: AI bias suggestions from history / past sessions** (mock exists)  
    Solution: Local stats (pick frequency inverse) or simple server endpoint. "Suggest bias" that sets weights.

44. **F: Pre-spin voting / temporary weights**  
    Solution: Separate "vote mode" where clients set preferred weights, averaged or locked before spin.

45. **F: Full rich exports (already SVG/WebM partial; add JSON archive + CSV + animated GIF proper)**  
    Solution: Complete utils/export, button for "Download full session bundle".

46. **F: Multi-session compare / side-by-side**  
    Solution: Open second session in split view or modal, compare elimination order / weights.

47. **F: Templates as first-class (server + user-saved)**  
    Solution: GET/POST /templates, "Save current as template".

48. **F: Replay mode** — step through full history with 3D scrub animation.  
    Solution: Timeline + play/pause that drives spin simulation from log.

49. **F: "Shame score" or ritual stats** (longest survivor, most picked person, bias effectiveness).  
    Solution: Compute in recap + analytics panel.

50. **F: Custom spin sounds / whoosh per session or name**  
    Solution: Allow upload short audio or choose from curated set (persist per session?).

51-65 F ideas (condensed):
51. Branching sessions from snapshot.
52. "Secret" hidden names until spin.
53. Integration: export to Slack / Notion / Miro sticky.
54. Time-boxed spins (auto spin after timer).
55. Weighted by external data (import CSV with scores).
56. Multiple wheels in one session (tabs).
57. "Blind" mode (hide names until reveal).
58. Post-spin "why" note capture (forced or optional).
59. Group/team bias (sub-weights).
60. Recurring scheduled sessions (future infra).
61. QR code join.
62. Results leaderboard across multiple sessions (with consent).
63. "Reverse wheel" — shame the last remaining.
64. Custom visual themes per ritual (retro, hiring, etc.).
65. Emoji reactions during spin (DataChannel or WS).

## 66-80 Architecture, State, Coupling, Separation

66. **A: Move flame particle logic to own composable/useFlame.ts**  
    Solution: Extract from App.vue (god component problem).

67. **A: Proper typed Action union + no more `as any` everywhere**  
    Solution: Finish mirroring backend enum exactly; remove remaining casts in history, App, timeline.

68. **A: Single source of truth: actions log as primary, participants as projection**  
    Solution: On load reconstruct from actions + latest snapshot. Eliminates pre/post drift.

69. **A: Central useStorage / composables for all localStorage** (mute, editor, recents, theme).  
    Solution: One composable with typed keys + reactivity.

70. **A: Pure math + state machine for spin lifecycle** (isLocalSpin + pending + remote)  
    Solution: Extract to useSpinMachine or similar.

71. **A: Better optimistic + conflict handling with sequence numbers**  
    Solution: Add `seq` or `version` to mutations; last-writer or merge strategy.

72. **A: Decouple WheelCanvas from direct Participant shape**  
    Solution: Pass declarative "WheelSpec {segments: {id,name,angle,color,weight}}".

73. **A: Use Pinia (or tiny custom) instead of scattered refs in App + composables**  
    Solution: For new work, migrate session state.

74. **A: Store trait + projection layer** (backend) — events always append, projection rebuilt.  
    Solution: Make snapshot creation consistent across memory/sqlite (always pre-mutation).

75-80 A solutions:
75. Remove direct mutation of activeParticipants from multiple places.
76. Make HistoryTimeline completely stateless (props only + emits).
77. Introduce clear "Command" pattern for mutations (frontend + backend).
78. Separate presence/hover WS concerns from core session events.
79. Extract api client to typed hooks with error types.
80. Feature flag service (client + optional server).

## 81-92 Backend, Scaling, Data, Security

81. **B: Consistent snapshot timing (pre-mutation) in all stores**  
    Solution: Fix remaining drift (memory vs sqlite already partially aligned).

82. **B: Full YDB editor method implementations** (parity).

83. **B: Rate limiting + basic abuse protection on spin / update props.**

84. **B: TTL for sessions + cleanup job** (memory especially).

85. **B: Optional lightweight auth / room passcode** (additive, not breaking).

86. **B: Export / import full session JSON (for backup or move between backends).**

87. **B: Better error taxonomy + structured logging (tracing spans for spin+history).**

88. **B: Read replicas or caching layer for list_actions / get_session on high load.**

89. **B: WebSocket scaling notes (Redis pub/sub for multi-instance).** (From earlier video-chat context but relevant.)

90-92 B:
90. Structured migrations (sqlx or dedicated).
91. IP / session ban + report flow (if needed for public instances).
92. Metrics endpoint (/metrics) for spin count, action rate, etc.

## 93-100 DevEx, Testing, Ops, Polish

93. **D: Property-based tests for weighted spin bias** (quickcheck / proptest).

94. **D: Integration test: two browser tabs, edit weight, spin, undo, verify both see same state + correct medals.**

95. **D: E2E bench extension (puppeteer already in bench/) for undo + weights flow.**

96. **D: Self-documenting ? / help with live examples.**

97. **D: Docker compose for dev (frontend + backend + sqlite) with hot reload.**

98. **X: "Fun modes": reverse elimination, team vs team, timed shame round.**

99. **X: Beautiful default seeds for common rituals (sprint, critique, hiring, daily standup).**

100. **X: "Wheel of Shame Hall of Fame" (opt-in public best/worst stories with consent).**

## Quick Wins Already Partially Done or Easy to Влей Next

- FPS counter (6)
- Real snapshot preview in history (done)
- Clamp + visual color (done)
- Editor toggle visible (done)
- Pure math extraction (2)
- Voice standard fallback (22)
- Prevent-repeat rule skeleton (42)
- Collapsible panels (23)

## How to Prioritize & Execute

1. P1 (now): Perf + hidden editor discoverability + remaining visual/weight consistency (many fixed).
2. P2: Comments + rules engine + richer exports.
3. P3: Architecture cleanup (god component, pure functions, typed events).
4. P4: Mobile + accessibility depth + real AI + multi-ritual features.
5. Long term: Scaling, auth-lite, integrations, "from scratch" state model.

All ideas designed to stay additive, preserve keyboard joy, animation ownership in WheelCanvas, identityColor as truth, no em-dashes.

Builds and existing tests must stay green after any implementation slice.

---

*Generated as direct follow-up to "топ 100 идей и предложени и решение проблем" + prior full problem audit and fixes.*  
*Self-rating on completeness of this list: 8/10 — exhaustive synthesis from all available artifacts + grounded solutions; 100 items reached by expansion + condensation.*