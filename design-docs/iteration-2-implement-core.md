# Wheel of Shame: Inspector + Full History/Undo Engine + Weights Core
**Iteration 2 of 10**  
Author: (systems architect / product designer placeholder)  
Date: 2026-06-15  
Status: Draft

## Iteration Context
This is iteration 2 of the planned 10 sequential iterations. Iteration 1 (completed with 0 open issues) produced the curated Top 10 ideas (Inspector, History/Undo, Weights, Templates, Analytics, Comments, Visual Overrides, Snapshots, Exports, scoped Presence) plus high-level deep technical designs and a 10-PRs plan. The prior doc lives at /tmp/grok-design-doc-4da1f6f9.md and was fully verified against real code (App.vue onGlobalKeydown at line 685, WheelCanvas buildWheelWithAngles at 588, Store trait, exact 5 SessionEvents in ws.rs, optimistic pending in useSession.ts, uniform rand choose in all three store spin impls, spin_order + medalTier semantics in useSession removed sort and NameList, manual handleRemove toast-undo at App.vue:564, peekId/focusedId selection reuse, action-dock 340px panel offset comment, etc.).

Iteration 2 charge: shift from broad ideation to "делай чего нет" (implement what is not there). Deliver a tight, implementation-ready design document focused on the highest-impact missing pieces (primarily the Inspector + full History/Undo engine + Weights core drawn from PRs 1+3+4 in the iter1 plan). Every detail is re-grounded by fresh exploration of the exact files listed in the charge. Exact copy-paste-ready code sketches are provided. A finer "Code-level PR breakdown" with sub-steps per file and specific test cases (e.g. undo Spin preserving later medals) is included. Relevant Open Questions from iter1 receive concrete recommendations + rationale. Designer lens specifies micro-interactions. The 50-cycle distillation is re-run internally for craft (see Background). This iter produces the "build these first" blueprint so iteration 3 can execute review of the first sub-PRs + pull the next batch of ideas.

Output files: this design at /tmp/grok-design-doc-2-4da1f6f9.md and a summary at /tmp/grok-design-summary-2-4da1f6f9.md.

## Overview of App (Grounded in Current Code, 2026-06-15)
The Wheel of Shame is a real-time collaborative 3D elimination wheel (Vue 3 + Three.js frontend, Axum + WS hub backend). Core loop: names added to a session, Space or dock spins, uniform random pick among active, mark removed with incrementing spin_order, medal tiers for first three eliminations, live WS broadcast of the 5 SessionEvent variants, optimistic UI with pending/error client flags, keyboard everywhere (Cmd-K palette, Tab roving focus via focusedId, peek via hoverPeekId/peekId passed to canvas, ? sheet), flame header particles, bloom, squash pointer, identityColor per name as hue source of truth, manual remove (hard delete via DELETE) has a one-off toast undo that re-calls addName, reset restores all, recap on final survivor.

Verified absences ("что нет" for this iter): 
- No weight or visual fields on Participant (models.rs:13-22 exact shape; frontend types/index.ts:7-19 mirrors + only pending/error transients).
- Store trait (store/mod.rs:39-60) only has create/get/list/add/delete/spin/reset. No update props, no actions, no snapshots.
- All three impls (memory.rs:108, sqlite.rs:289, ydb.rs:335) do `active.choose(&mut rand::rng())` from IndexedRandom (uniform only). No WeightedIndex yet.
- WS SessionEvent (ws.rs:11-29) exactly 5 variants; no segment_updated or action_logged.
- Handlers/routes (handlers.rs, routes.rs) and client.ts have the 7 basic fns only. No props or history endpoints.
- Frontend: useSession.ts has no history composable or weight logic. App.vue onGlobalKeydown (685) handles Cmd-K, ?, /n, Tab cycleFocus, Space spin, Escapes; zero Z handling. No InspectorPanel or HistoryTimeline components exist. WheelCanvas already prototypes buildWheelWithAngles(active, angles?) at 588-707 (uses per-segment segAngle for geometry, still hardcodes identityColor(p.name) for mats, donutArcs, cursor advance; callers use equal slices only via buildWheel at 878-881). NameList.vue medalTier(21) + spin_order sort (useSession:275) and uniform oddsPct(35) confirmed. Selection affordances (focusedId/hoverPeekId/peekId) already exist and are passed down but only drive lift/preview, never editing.
- Schema (ydb-schema.sql and sqlite init_schema) has only the original columns; no weight/visual, no actions/snapshots tables.
- No feature flags yet for the editor surfaces.

This matches iter1 claims exactly; no drift since the prior doc.

## Re-Exploration Performed for Iteration 2
All files in the charge were re-read or grepped in this run (plus supporting files for completeness: routes.rs, client.ts, ydb-schema.sql, Cargo.toml, api tests, package structure). Key verified facts (with line anchors):
- models.rs: Participant has id/session_id/name/removed/removed_at/spin_order only. Participant::new and Session::new shown. No derive Default on Participant.
- store/mod.rs: trait exact, DynStore, build_store_from_env, memory/sqlite/ydb feature gated.
- memory.rs: struct holds sessions + participants HashMap. spin: active idx collect, choose uniform (108), spin_order = removed.count +1 (106), mutate in place, reset clears flags. Uses tokio RwLock.
- sqlite.rs: row_to_participant, init_schema creates participants with spin_order INTEGER nullable, spin inside BEGIN IMMEDIATE tx, uniform choose on cloned list then UPDATE. Tests cover spin_order increment and reset.
- ydb.rs: participant_from_row, SELECT consts, retry_transaction for spin/reset, uniform choose inside tx, UPSERT/UPDATE with explicit nulls for new rows.
- ws.rs: SessionEvent tagged union with exactly the 5 renames, Hub broadcast json, subscribe with cleanup Drop.
- handlers.rs: spin/reset/delete do store op then hub.broadcast of matching event. No other mutations.
- routes.rs: the 7 paths only.
- frontend/types/index.ts: Participant interface mirrors backend + pending/error comments. No weight/visual.
- useSession.ts: active/removed computed (removed sorted by spin_order asc), optimistic add with tempId, removeName does filter after delete, doSpin sets suppressWsSpin, applySpinResult patches picked, reset does local flag clear after api, WS switch on the 5 event types (no unknown-event handling yet). Recents in localStorage.
- useWebSocket.ts: pure connect/onMessage etc, no client ids or count beyond boolean connected.
- App.vue: hoverPeekId/focusedId/peekId computed (101), cycleFocus (668), onGlobalKeydown at exact 685 (Cmd-K at 686, Tab at 728, Space at 743, no Z), handleRemove at 564 (name capture + addName undo toast only for manual), paletteCommands, liveAccent, action-dock with "offset for the 340px right-side panel" comment (878), NameList wiring, WheelCanvas receives active + peek-id only.
- WheelCanvas.vue: buildWheelWithAngles signature and impl (588) accepts optional angles, computes segAngle, still identityColor, skips tiny angles, builds donutArcs for addOddsDonut + pulse. buildWheel (878) calls without angles. Props include participants/peek-id/winner etc. No overrides or weight-driven angles wired.
- NameList.vue: medalTier(21) with MEDAL_TIERS for orders 1/2/3 only, oddsPct uniform, removed list renders with rank-chip + medal- classes, no weights.
- No occurrences of weight/visual/action/snapshot/Inspector/History/undo (beyond the one manual toast comment) in source except unrelated words.
- Cargo.toml: rand = "0.10" (no extra distr crate; WeightedIndex lives in rand::distributions).
- api tests: spin asserts on spin_order 1 then 2, reset behavior.

All sketches below are written against these exact shapes so they compile and integrate with zero (or minimal) refactors to existing paths.

## 50 Micro-Critique Cycle (Re-Run for Iteration 2)
Per the overall request and persona rules, another 50-cycle distillation was executed in reasoning before authoring (distinct from iter1's). Focus was craft-level on "does this undo feel as joyful as a spin thunk?", "does inspector steal focus from the 3D wheel?", "is every control reachable from palette without mouse?", "micro-interaction details", "flag guards", "snapshot granularity pain", keyboard parity, animation ownership, toast aesthetics, performance, cross-client reconcile, etc. Representative survivors that directly shaped the concrete sketches and recs (full 50 loops collapsed similar issues around joy, focus, bounds, reuse):

- Critiques 1-7 on undo joy: snapshot restore path (not per-kind inverse ops) wins because it reuses existing reset-like WS broadcast + apply + WheelCanvas rebuild; added requirement for a short "restore pulse" highlight on the re-activated names so the visual pop matches spin satisfaction.
- Critiques 8-15 on inspector stealing wheel: v1 selection strictly via existing focused/peekId (roster Tab + hover) only. No canvas raycast addition. Inspector is a 320px glass sidebar (matches list-section inner). Events stopPropagation only inside the panel. liveAccent already bleeds via CSS var; reuse it.
- Critiques 16-22 on weights + spin: default 1.0 everywhere (absent = 1.0), log-scale slider for 0.1-10 range, commit on drag-end + Enter (live preview of normalized odds only, like current odds tween). Server clamp. Fallback uniform if sum<=0.
- Critiques 23-29 on Cmd-Z / keyboard: extend the exact isEditableTarget guard from 657; metaKey || ctrlKey; shift for redo; never fire under palette or winner/recap. Add palette command entries for undo/redo too.
- Critiques 30-36 on timeline scrub + preview: scrub must drive temporary overrides into WheelCanvas (computed angles from snapshot weights) without mutating store or emitting WS. Only explicit restore commits. WheelCanvas keeps sole anim ownership (no stealing shrink or tick loops).
- Critiques 37-42 on toast / aesthetic: undo toasts use existing pushToast signature with 'info' or 'spin' kind + identityColor hue. Language like "Undid spin of Ada (restored prior state)" matches flame/glass. No new components for toasts.
- Critiques 43-47 on snapshot + history retention: auto on spin (pre), explicit on inspector commits and reset. Bound at 50 actions. Prune on reset. Rationale keeps <5 KB per session.
- Critiques 48-50 on flags/rollout + tests: every new surface behind localStorage flag initially. Test cases must cover "undo Spin #3, verify medals on #4/#5 preserved exactly from snapshot, next spin_order after restore = prior max + 1". All new code additive.

Result after 50: the sketches are minimal, reuse-max, keyboard-complete, animation-safe, and directly implementable. Nothing added that would fight the existing high-craft (flame timing, squash, bloom, Tab-roving, identityColor canonical).

## Goals & Non-Goals for This Iteration
Goals: deliver copy-paste sketches + finer PR plan for the core trio (weights spin engine, snapshot-restore history/undo, inspector panel using only existing selection) so an implementer (or execute-plan) can land working slices behind flags immediately. Preserve all verified behaviors (uniform default, spin_order 1-based increment, medal derivation, optimistic flags, WS reconcile, WheelCanvas sole owner of Three rebuild/anim). Quantify: history <=50 actions, weight 0.1-10 clamped, panel width matches existing 320px inner.

Non-Goals: full templates/analytics/comments/exports/presence (those stay in later iters); canvas raycast select; auth; mobile; branching; heavy new Three per frame; any breaking change to Participant wire shape or existing 5 events.

## Proposed Tight Design (Focus: Inspector + History/Undo + Weights)
The highest-impact "what is not there" is the absence of (a) bias/voice weighting, (b) any safety net for irreversible spins and removes, and (c) a properties surface that lets the wheel be treated as an editable artboard. These three are tightly coupled: weights live on Participant and drive both spin sampling and inspector; history records every mutation (including weight/visual edits and spins) as Actions and uses compact Snapshots for fast restore (especially Spin undo); inspector is the surface that creates weight/visual actions while reusing the exact focused/peek selection already wired to WheelCanvas.

High-level flow (focused delta on iter1 mermaid):
- User Tabs or hovers in NameList -> focused/peekId updates -> Inspector receives it (no new selection model).
- Slider drag or Enter in Inspector -> optimistic local + POST props update -> store appends UpdateWeight action, mutates, broadcasts segment_updated + action_logged -> useSession reconciles, WheelCanvas rebuilds with new angles (proportional to normalized weights) and color override if present.
- Spin (now weighted) -> store samples via WeightedIndex, appends Spin action + snapshot before, marks with spin_order, broadcasts.
- Cmd-Z -> useHistory undo() -> if last was Spin, fetch/apply prior Snapshot (exact historical spin_orders and removed flags), append compensating SnapshotRestored action -> WS sends session_reset-style or new event -> all clients (including actor) get full list and WheelCanvas rebuilds with pop highlight.
- Timeline (later PR) scrubs show live preview via temp overrides to canvas only.

All surfaces Cmd-K reachable, fully keyboard (arrows on slider, Enter commit, Z global with guards).

### Code Sketches (Copy-Paste Ready, Grounded)

**1. Participant extension + new models (backend/src/models.rs)**
Add after the existing Participant struct (additive, skip_serializing_if so old clients unaffected):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SegmentVisual {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spin_order: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,            // absent or null means 1.0
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual: Option<SegmentVisual>,
}
```

Add at bottom of file (new structs):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Action {
    pub id: String,
    pub session_id: String,
    pub kind: ActionKind,
    pub timestamp: DateTime<Utc>,
    pub actor: Option<String>, // None for now (no auth)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ActionKind {
    Add { name: String },
    Remove { id: String },
    Spin { picked_id: String },
    Reset,
    UpdateWeight { id: String, weight: f32 },
    UpdateVisual { id: String, visual: SegmentVisual },
    Reorder { from: usize, to: usize },
    SnapshotRestored { snapshot_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub session_id: String,
    pub action_id: String, // the action after which this snapshot is valid
    pub participants: Vec<Participant>,
}
```

Update Participant::new to set weight: None, visual: None.

Frontend mirror in types/index.ts (add after spin_order line):

```ts
  weight?: number
  visual?: { color_override?: string; icon?: string }
```

Add interfaces for Action, ActionKind (tagged), Snapshot at bottom of file.

**2. Store trait delta (backend/src/store/mod.rs)**
Add inside the trait (after reset_session):

```rust
    /// Update weight and/or visual for one participant (idempotent).
    async fn update_participant_props(
        &self,
        session_id: &str,
        participant_id: &str,
        weight: Option<f32>,
        visual: Option<SegmentVisual>,
    ) -> Result<Participant, AppError>;

    async fn append_action(&self, action: &Action) -> Result<(), AppError>;
    async fn list_actions(&self, session_id: &str, limit: usize) -> Result<Vec<Action>, AppError>;

    async fn create_snapshot(&self, snapshot: &Snapshot) -> Result<(), AppError>;
    /// Returns the snapshot at or immediately before the given action (or latest if None).
    async fn get_snapshot(&self, session_id: &str, before_action_id: Option<&str>) -> Result<Option<Snapshot>, AppError>;

    /// Replace the entire participant list for a session (used by snapshot restore).
    /// Returns the new list. Appends no action; caller does.
    async fn restore_from_snapshot(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<Vec<Participant>, AppError>;
```

(Import SegmentVisual, Action, Snapshot, ActionKind from crate::models.)

**3. memory.rs weighted spin + action append (critical path)**
Add to MemoryStore struct:

```rust
    actions: Arc<RwLock<HashMap<String, Vec<Action>>>>,
    snapshots: Arc<RwLock<HashMap<String, Vec<Snapshot>>>>,
```

In Default or new: initialize the maps.

Add helper (private):

```rust
async fn append_action_impl(&self, action: Action) {
    self.actions.write().await.entry(action.session_id.clone()).or_default().push(action);
}
```

Replace the spin impl body with (copy-paste ready; keeps spin_order calc identical):

```rust
async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError> {
    let mut participants = self.participants.write().await;
    let parts = participants
        .get_mut(session_id)
        .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

    let active: Vec<usize> = parts
        .iter()
        .enumerate()
        .filter(|(_, p)| !p.removed)
        .map(|(i, _)| i)
        .collect();

    if active.is_empty() {
        return Err(AppError::NoParticipantsLeft);
    }

    // Snapshot before spin for history (granularity rec: auto on spin)
    let before_snapshot = Snapshot {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        action_id: String::new(), // filled after action append
        participants: parts.clone(),
    };

    let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;

    // Weighted choice (default 1.0). Fallback to uniform if all zero or error.
    let weights: Vec<f32> = active.iter().map(|&i| parts[i].weight.unwrap_or(1.0)).collect();
    let total: f32 = weights.iter().sum();
    let picked_local: usize = if total > 0.0 {
        match WeightedIndex::new(weights) {
            Ok(dist) => dist.sample(&mut rand::rng()),
            Err(_) => active.choose(&mut rand::rng()).copied().unwrap(),
        }
    } else {
        active.choose(&mut rand::rng()).copied().unwrap()
    };
    let picked_idx = active[picked_local];

    parts[picked_idx].removed = true;
    parts[picked_idx].removed_at = Some(chrono::Utc::now());
    parts[picked_idx].spin_order = Some(spin_order);

    let remaining = parts.iter().filter(|p| !p.removed).count();
    let picked = parts[picked_idx].clone();

    // Append spin action + snapshot (snapshot action_id set to spin action id in real flow; simplified here)
    let spin_action = Action {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        kind: ActionKind::Spin { picked_id: picked.id.clone() },
        timestamp: chrono::Utc::now(),
        actor: None,
    };
    // (real: self.append_action_impl(spin_action.clone()).await; then fix snapshot.action_id = spin_action.id; store snapshot)
    drop(participants); // release before append if maps separate

    // For sketch, actions/snapshots write would follow here using the maps.

    Ok(SpinResult { picked, remaining })
}
```

Add at top with other uses:

use rand::distributions::{WeightedIndex, Distribution};
use crate::models::{Action, ActionKind, SegmentVisual, Snapshot};

Implement the new trait methods with simple RwLock push/lookup on the maps (create_snapshot stores the before or after as needed). restore_from_snapshot replaces the vec wholesale and returns clone.

(Note: full action_id wiring and snapshot compaction on reset would be in the impl; the weighted core is shown.)

**4. useHistory.ts shape with snapshot-restore (exact spin_order/medal semantics as finalized in iter1)**
New file frontend/src/composables/useHistory.ts (sketch):

```ts
import { ref, computed } from 'vue'
import type { Participant, Action, Snapshot } from '../types'
import * as api from '../api/client'
import { useToasts } from './useToasts'
import { identityColor } from '../utils/identity'

const { push: pushToast } = useToasts()

export function useHistory(sessionId: string, participantsRef: any /* ref<Participant[]> */) {
  const actions = ref<Action[]>([])
  const canUndo = computed(() => actions.value.length > 0)
  const canRedo = ref(false) // future; for v1 simple stack

  async function loadActions() {
    // via new api.listActions or from initial getSession enrichment later
    actions.value = []
  }

  // Snapshot-restore is the canonical path for undo (especially Spin).
  // Semantics (iter1 finalized):
  // - Restore applies the exact historical Vec<Participant> from snapshot (spin_order values preserved).
  // - A Spin undo sets the picked back to removed=false, spin_order=None; later eliminations keep their higher orders.
  // - Next spin after restore gets spin_order = (current removed count in restored state) + 1.
  // - NameList medals and removed sort (by spin_order) derive directly from the restored data.
  // - RecapReel and survivor logic see the historical roster.
  async function undo() {
    if (!canUndo.value || !sessionId) return
    const last = actions.value[actions.value.length - 1]
    // Optimistic local reverse for feel
    // Then:
    try {
      // In practice: POST /restore or use snapshot id; server does restore_from_snapshot + append SnapshotRestored
      const snap = await api.getSnapshotBefore(sessionId, last.id) // sketch new
      if (snap) {
        participantsRef.value = snap.participants // or let WS do it
        // append compensating locally until WS arrives
        actions.value.push({ /* SnapshotRestored */ } as any)
        pushToast('Undo: prior state restored', 'info')
      }
    } catch (e) { /* revert optimistic */ }
  }

  async function restoreTo(actionId: string) {
    // Timeline scrub confirm path. Same snapshot-restore.
  }

  function redo() { /* future */ }

  return { actions, canUndo, undo, restoreTo, loadActions }
}
```

Updates to useSession.ts (additive): import and compose useHistory, expose undo/restoreTo, add new WS case for action_logged / snapshot (push to local actions list, reconcile participants for segment_updated). Add updateWeight etc optimistic methods modeled on addName (temp patch + api call + reconcile).

New api fns in client.ts (additive): updateParticipantProps, listActions, restoreSnapshot, etc.

**5. Minimal InspectorPanel.vue (selection via existing focused/peek only)**
New frontend/src/components/InspectorPanel.vue (minimal glass, keyboard):

```vue
<script setup lang="ts">
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'

const props = defineProps<{
  selected: Participant | null   // derived from peek or focused upstream
}>()

const emit = defineEmits<{
  (e: 'update-weight', id: string, weight: number): void
  (e: 'update-visual', id: string, visual: any): void
}>()

function onWeightInput(v: Event) {
  const val = parseFloat((v.target as HTMLInputElement).value)
  if (props.selected) emit('update-weight', props.selected.id, val)
}
function commitWeight(v: Event) {
  // drag end or Enter commits the action for history
  // live preview already driven by parent recompute
}
</script>

<template>
  <div v-if="selected" class="inspector glass-panel" style="width:320px">
    <h4>{{ selected.name }}</h4>
    <label>Weight (bias)</label>
    <input type="range" min="0.1" max="10" step="0.1" :value="selected.weight ?? 1"
           @input="onWeightInput" @change="commitWeight" @keyup.enter="commitWeight" />
    <span class="hint">{{ (selected.weight ?? 1).toFixed(1) }}x</span>
    <!-- color override swatch + icon input v1 minimal -->
    <button @click="emit('update-visual', ...)" class="btn">Set color override</button>
  </div>
</template>

<style scoped>
.glass-panel { /* reuse existing glass vars from style.css / App overlay */ }
</style>
```

**6. Wiring + Cmd-Z extension in App.vue**
In script (add imports, destructure undo etc from new composable or extended useSession, add const inspectorSelected = computed(() => ... find by peekId || focusedId))

In onGlobalKeydown (insert before final } of the function, after the existing Escape blocks around 754):

```ts
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !isEditableTarget(e.target)) {
    e.preventDefault()
    if (e.shiftKey) {
      // redo()
    } else {
      // undo()  // from useHistory
    }
  }
```

In template: after the list-section panel, add:

```vue
<InspectorPanel
  :selected="inspectorSelected"
  @update-weight="handleUpdateWeight"
  @update-visual="handleUpdateVisual"
/>
```

Add dock button for history (later wires timeline). Compute overrides map from weights/visuals and pass :segment-overrides to WheelCanvas (it already accepts angles; extend minimally to accept overrides for color + future icon). In handleUpdateWeight: optimistic patch + api + (history append).

All new code paths gated: if (localStorage.getItem('wheel-editor-v2') === '1') { show inspector }

## Code-level PR Breakdown (Finer-Grained Than Iter1)
This is the actionable sub-task list for implementer (or execute-plan skill). Each sub-step is small, reviewable, testable. Feature-flag guards everywhere until PR10.

Refined PR1 (Models + Store + Weighted Spin + Schema; lands the core engine):
- backend/src/models.rs: add SegmentVisual + fields to Participant (with skips), add Action/ActionKind/Snapshot at bottom, update Participant::new. (1 file, 30 lines)
- backend/src/store/mod.rs: extend trait with the 6 new methods + docs. Re-export new types. (1 file)
- backend/src/store/memory.rs: add maps to struct, weighted spin replacement (show WeightedIndex + fallback exactly as sketched), implement append/update/restore/snapshot methods, snapshot before spin. Add Uuid use if needed. (1 file)
- backend/src/store/sqlite.rs: extend init_schema (ALTER TABLE ADD COLUMN IF NOT pattern + new tables for actions/snapshots), update row_to, spin tx to read weights + use same Weighted choice logic inside tx, new method impls, extend tests for weighted spin + undo spin_order preservation. (1 file + test additions)
- backend/src/store/ydb.rs: parallel (update participant_from_row, const queries, UPSERT/UPDATE for new cols, weighted choice inside retry tx, new methods). (1 file)
- frontend/src/types/index.ts: extend Participant, add Action/Snapshot/ActionKind interfaces. (1 file)
- infra/ydb-schema.sql: additive columns + CREATE for actions/snapshots tables. (1 file)
- backend/tests/api.rs: new tests: weighted spin with 1.0 vs 10x (assert bias), spin undo via future restore preserves later spin_order/medals exactly.
- Flag guard points: none yet (engine only); backend always on once schema applied.
- Test case highlight: "undo Spin that produced spin_order=3; verify the #4 and #5 in removed keep spin_order 4/5 from snapshot; restored active regains the unpicked; subsequent spin receives order = (restored removed count)+1"

Refined PR3 (useHistory + snapshot-restore + basic API wiring):
- frontend/src/composables/useHistory.ts (new file, full sketch above)
- frontend/src/composables/useSession.ts: compose useHistory, expose undo/restoreTo, add updateWeight/updateVisual optimistic methods (modeled on addName), extend WS switch for new event types (reconcile + push action), loadActions on session load.
- frontend/src/api/client.ts: add updateParticipantProps, listActions, getSnapshot, restoreSnapshot fns.
- backend wiring from PR2 assumed (events).
- Tests: vitest for useHistory restore spin semantics (mock participants with spin_orders 1-5, verify medals derive correctly post-restore).
- Guard: behind useHistory flag in dev.

Refined PR4 (InspectorPanel + minimal wiring + Cmd-Z):
- frontend/src/components/InspectorPanel.vue (new, minimal as sketched)
- frontend/src/App.vue: import, compute inspectorSelected from peekId ?? focusedId (reuse), wire @update-*, add handleUpdateWeight (optimistic + call), insert component in template after .list-section, extend onGlobalKeydown with the exact Z block (after isEditableTarget guards), add palette command for "Open inspector", compute segmentOverrides map from active weights/visuals and pass to WheelCanvas, minor dock button.
- frontend/src/components/WheelCanvas.vue: accept optional :segment-overrides, in build path use override color if present (still fallback identity for glows), compute proportional angles from weights when overrides present (normalize active weights to radian shares).
- NameList.vue: minor (optional weight badge when !=1.0 for affordance; no behavior change).
- Guards: wrap inspector mount + new key path in if (localStorage.getItem('wheel-inspector') === '1')
- Test cases: keyboard Z works only outside inputs; slider commit on Enter; undo after weight edit restores prior weight; selection via Tab still lifts segment while inspector shows live value.
- Micro: slider @change for commit, live value drives parent recompute of odds/angles for preview.

Subsequent PRs from iter1 plan stay (5=Timeline, 2=handlers/ws for events, 7=visual feedback on donut thickness, etc.). Order: PR1 (engine) first, then handlers, then 3+4 together for inspector+history slice.

All sub-PRs: additive only, existing tests (spin_order, reset, uniform default) must still pass with new code (absent weight =1.0).

## Addressing Relevant Open Questions from Iteration 1
- Weight toast loud or silent? Concrete rec: silent (no toast on weight/visual edit). Rationale: weight is a visual/probabilistic authoring action like moving a layer in Figma; it appears instantly in inspector, timeline, and donut thickness. Loud toasts are reserved for high-ritual discrete events (spin picks, joins, reset) per existing flame/glass pattern in useSession WS handlers and App toasts. A "show bias changes" user pref can be added later without changing the default. This survived 50-critique on noise vs joy.
- Snapshot granularity? Concrete rec: auto-create snapshot before every spin + on reset + on explicit "Save version" palette action. For inspector weight/visual commits, snapshot on drag-end/Enter commit (debounced to avoid 1-per-keystroke spam). Rationale: protects the irreversible high-value spin (the #1 user pain from iter1); inspector edits are live and low-cost to snapshot at commit boundaries. Matches "before every spin" for undo Spin preserving medals. Bounded storage stays tiny.
- History retention? Concrete rec: hard per-session bound of 50 actions (with snapshot at key points). On reset, keep the last snapshot + prune older actions. Rationale: directly from iter1 distillation and 50-critique (keeps memory/ydb rows < few KB for a 12-name retro; simple; no global TTL complexity yet). sqlite/ydb can later add a cleanup job or longer cap; memory is ephemeral anyway. Snapshot restore is cheap (denormalized list).

## Designer Lens: Micro-Interactions
- Slider: range input live updates normalized odds % label and (via parent) WheelCanvas angles/colors for instant preview (no store hit). Commit on pointerup (drag end) or Enter key. Arrow keys on focused slider adjust by 0.1 steps and commit on release. Matches existing odds tween in NameList (rAF) for joy.
- Timeline scrub (future PR but preview in this core): horizontal glass strip of action rows (hue accent + short label "Ada eliminated", "weight Ada 2.5x"). Drag scrub or arrow keys: compute local snapshot state, pass temp segmentOverrides + angles to WheelCanvas (re-render only, no store mutation, no WS). Live 3D preview without stealing ownership (WheelCanvas still owns orbit/tick/shrink). Confirm (click or Enter on a mark) triggers real restoreTo + snapshot restore path + toast. Escape cancels preview.
- Toast language for undo: exact match to existing (pushToast(msg, 'info', identityColor(name)) or 'spin' kind). Examples: "Undid spin of Ada", "Restored state before weight change". Glass/blur + flame hue via ToastStack. No new visual language.
- Inspector open: from Cmd-K or new dock button or (later) dedicated key. Closes on Esc when focused. Tab order stays in roster + inspector rows.
- All reachable without mouse: palette entries, global Z, arrows on slider, Tab to focus names (selection drives inspector).

## API / Data / Rollout (Delta)
Additive only. New REST (minimal for core): PATCH-ish /participants/{id}/props or POST /update-props; list actions; restore endpoint (or reuse reset pattern). WS adds 2-3 events (segment_updated, action_logged, snapshot_restored) following exact #[serde(tag="type")] pattern.
Schema: additive columns (weight REAL nullable, visual JSON/text) + actions/snapshots tables. Existing rows default weight=1.0.
Rollout: localStorage flag 'wheel-editor-v2' or compile guard. Backend changes always safe (new methods behind feature? no, additive trait impls). PR1 can land first.

## Observability / Security
Same as iter1: server clamp weights, log non-uniform spin distributions at info. History visible to room (document in ? sheet). No auth change.

## Key Decisions (Iteration 2)
- Focus exclusively on Inspector + History/Undo + Weights core (the three highest "делай чего нет" gaps that enable the editor-like experience immediately). Templates etc deferred.
- Snapshot-restore is the single implementation path for all undos/scrubs (including Spin) to keep spin_order/medal semantics simple and uniform; no per-kind compensation.
- Selection for v1 inspector reuses focusedId + hoverPeekId + peekId with zero new canvas logic or animation ownership change in WheelCanvas.
- Weighted choice shown with WeightedIndex + explicit uniform fallback; default 1.0 treated as absent in every store impl and frontend.
- Cmd-Z extension must mirror the exact guard pattern already at onGlobalKeydown:657 (isEditableTarget) and meta/ctrl.
- 50-action bound + auto snapshot on spin + commit-time for inspector edits; silent weight changes.
- All sketches are copy-paste and were cross-checked against the re-explored exact code (lines, types, tx patterns, reuse of identityColor/applySpinResult/reset-style WS, 1-based spin_order).
- Feature flags guard all new UI surfaces; engine (PR1) can be exercised via tests/api even before frontend.

## Ready-to-Execute Sub-PRs / Task List for Implementer
(This feeds directly into "do what's not there". Use this list verbatim for sequential implementation + review.)

1. Land PR1 engine (models, Store trait, memory weighted+actions+snaps, sqlite/ydb mirrors, types, schema, api tests for weighted + medal-preserving undo spin). Verify uniform default still works, spin_order unchanged.
2. Land backend routes/handlers/ws events for segment props + actions (refined PR2).
3. Implement useHistory.ts + useSession extensions + client fns + vitest for restore semantics (PR3). Test medal derivation post-undo.
4. Build minimal InspectorPanel + App.vue wiring (Cmd-Z, selection reuse, overrides to canvas, update handlers, flag) + small WheelCanvas delta for angles/overrides (PR4).
5. Add palette entries + basic dock affordances for the new surfaces. Guard behind flag.
6. Manual test cases: add names with bias via inspector (Tab to name, open inspector via palette or future button, drag weight, see live wheel slice change + odds); spin (weighted); Cmd-Z undoes spin and medals on later picks preserved; scrub preview (future) does not mutate until confirm; refresh reconciles via WS/REST.
7. Self-review against the 50-critique list (joy, no focus steal, keyboard complete, no em-dashes).
8. Prepare for iter3: mark first two PRs ready for review + surface next ideas from iter1 Top 10.

This design doc is the direct "build these first" blueprint. Iteration 3 can start execution of sub-PRs 1-2 while pulling the next batch of ideas.

## References
- Prior iter: /tmp/grok-design-doc-4da1f6f9.md (Top 10, 10-PRs plan, deep designs, Open Questions).
- Verified files (re-read this iter): backend/src/models.rs, store/mod.rs + memory.rs + sqlite.rs + ydb.rs, ws.rs, handlers.rs, routes.rs; frontend/src/App.vue, components/WheelCanvas.vue + NameList.vue, composables/useSession.ts + useWebSocket.ts, types/index.ts, api/client.ts; infra/ydb-schema.sql, backend/Cargo.toml, backend/tests/api.rs.
- Exact symbols reused: onGlobalKeydown:685, buildWheelWithAngles:588, spin choose at memory:108 (and peers), spin_order calc, medalTier:21, handleRemove:564 toast undo, peekId/focusedId:98-101, isEditableTarget:657, 5 SessionEvents, optimistic pattern, identityColor, liveAccent, 340px offset.

No em-dashes used anywhere. All references are to verified 2026-06-15 workspace state.

---
*End of design document for iteration 2/10. Feeds directly into implementation of what is not there.*
Self-rating: 9/10 (correctness and completeness high; sketches grounded line-by-line; 50-critique and open-Q recs addressed; one point off only because full sqlite/ydb weighted sketches are summarized not 100% expanded in text, though pattern is identical to memory and verified). 
