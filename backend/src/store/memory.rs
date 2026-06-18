//! In-memory storage for local development and tests.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use rand::prelude::IndexedRandom;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::models::{Action, Participant, SegmentVisual, Session, Snapshot, SpinResult};

use rand::distr::weighted::WeightedIndex;
use rand::distr::Distribution;
use super::Store;

/// In-memory storage. State is lost on restart and not shared across
/// processes; intended for local development and tests.
#[derive(Debug, Clone, Default)]
pub struct MemoryStore {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    participants: Arc<RwLock<HashMap<String, Vec<Participant>>>>,
    actions: Arc<RwLock<HashMap<String, Vec<Action>>>>,
    snapshots: Arc<RwLock<HashMap<String, Vec<Snapshot>>>>,
}

#[async_trait]
impl Store for MemoryStore {
    async fn create_session(&self, session: &Session) -> Result<(), AppError> {
        self.sessions
            .write()
            .await
            .insert(session.id.clone(), session.clone());
        self.participants
            .write()
            .await
            .insert(session.id.clone(), vec![]);
        self.actions
            .write()
            .await
            .insert(session.id.clone(), vec![]);
        self.snapshots
            .write()
            .await
            .insert(session.id.clone(), vec![]);
        Ok(())
    }

    async fn get_session(&self, id: &str) -> Result<Option<Session>, AppError> {
        Ok(self.sessions.read().await.get(id).cloned())
    }

    async fn list_participants(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        Ok(self
            .participants
            .read()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn add_participants(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<(), AppError> {
        // Verify the session exists before inserting so we don't create
        // orphan participants for a deleted/nonexistent session.
        if !self.sessions.read().await.contains_key(session_id) {
            return Err(AppError::NotFound("Session not found".into()));
        }
        self.participants
            .write()
            .await
            .entry(session_id.to_string())
            .or_default()
            .extend_from_slice(participants);
        Ok(())
    }

    async fn delete_participant(
        &self,
        session_id: &str,
        participant_id: &str,
    ) -> Result<(), AppError> {
        let mut participants = self.participants.write().await;
        let parts = participants
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

        let idx = parts
            .iter()
            .position(|p| p.id == participant_id)
            .ok_or_else(|| AppError::NotFound("Participant not found".into()))?;

        parts.remove(idx);
        Ok(())
    }

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

        // Snapshot before spin for history (auto granularity)
        let _before_snapshot = Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            action_id: String::new(),
            participants: parts.clone(),
        };

        let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;

        // Weighted choice (default 1.0). Fallback to uniform if sum==0 or error.
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

        // Append spin action + snapshot (simplified wiring for now; full in later steps)
        let spin_action = Action {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            kind: crate::models::ActionKind::Spin { picked_id: picked.id.clone() },
            timestamp: chrono::Utc::now(),
            actor: None,
        };
        // direct append (trait method available in impl block)
        let _ = self.append_action(&spin_action).await;

        let snap = Snapshot {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            action_id: spin_action.id,
            participants: parts.clone(),
        };
        let _ = self.create_snapshot(&snap).await;  // in real would use before snapshot

        drop(participants);

        Ok(SpinResult { picked, remaining })
    }

    async fn reset_session(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        let mut participants = self.participants.write().await;
        let parts = participants
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

        for p in parts.iter_mut() {
            p.removed = false;
            p.removed_at = None;
            p.spin_order = None;
        }

        Ok(parts.clone())
    }

    async fn update_participant_props(
        &self,
        session_id: &str,
        participant_id: &str,
        weight: Option<f32>,
        visual: Option<SegmentVisual>,
    ) -> Result<Participant, AppError> {
        let mut participants = self.participants.write().await;
        let parts = participants
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound("Session not found".into()))?;
        let p = parts
            .iter_mut()
            .find(|p| p.id == participant_id)
            .ok_or_else(|| AppError::NotFound("Participant not found".into()))?;
        if let Some(w) = weight {
            p.weight = Some(w);
        }
        if let Some(v) = visual {
            p.visual = Some(v);
        }
        Ok(p.clone())
    }

    async fn append_action(&self, action: &Action) -> Result<(), AppError> {
        self.actions
            .write()
            .await
            .entry(action.session_id.clone())
            .or_default()
            .push(action.clone());
        Ok(())
    }

    async fn list_actions(&self, session_id: &str, limit: usize) -> Result<Vec<Action>, AppError> {
        let acts = self.actions.read().await;
        let list = acts.get(session_id).cloned().unwrap_or_default();
        Ok(list.into_iter().rev().take(limit).collect())
    }

    async fn create_snapshot(&self, snapshot: &Snapshot) -> Result<(), AppError> {
        self.snapshots
            .write()
            .await
            .entry(snapshot.session_id.clone())
            .or_default()
            .push(snapshot.clone());
        Ok(())
    }

    async fn get_snapshot(&self, session_id: &str, before_action_id: Option<&str>) -> Result<Option<Snapshot>, AppError> {
        let snaps = self.snapshots.read().await;
        let list = snaps.get(session_id).cloned().unwrap_or_default();
        if let Some(before) = before_action_id {
            // find latest with action_id <= before (assume lexical or id order for simplicity)
            Ok(list.into_iter().filter(|s| s.action_id.as_str() <= before).last())
        } else {
            Ok(list.into_iter().next_back())
        }
    }

    async fn restore_from_snapshot(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<Vec<Participant>, AppError> {
        let mut parts = self.participants.write().await;
        let slot = parts
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound("Session not found".into()))?;
        *slot = participants.to_vec();
        Ok(slot.clone())
    }
}
