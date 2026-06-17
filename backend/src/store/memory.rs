//! In-memory storage for local development and tests.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::models::{Participant, Session, SpinResult};

use super::{choose_weighted_active_index, Store};

/// In-memory storage. State is lost on restart and not shared across
/// processes; intended for local development and tests.
#[derive(Debug, Clone, Default)]
pub struct MemoryStore {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    participants: Arc<RwLock<HashMap<String, Vec<Participant>>>>,
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

    async fn update_participant(
        &self,
        session_id: &str,
        participant_id: &str,
        pinned: Option<bool>,
        weight: Option<u32>,
    ) -> Result<Participant, AppError> {
        let mut participants = self.participants.write().await;
        let parts = participants
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

        let participant = parts
            .iter_mut()
            .find(|p| p.id == participant_id)
            .ok_or_else(|| AppError::NotFound("Participant not found".into()))?;

        if let Some(pinned) = pinned {
            participant.pinned = pinned;
        }
        if let Some(weight) = weight {
            participant.weight = weight;
        }

        Ok(participant.clone())
    }

    async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError> {
        let mut participants = self.participants.write().await;
        let parts = participants
            .get_mut(session_id)
            .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

        let picked_idx = choose_weighted_active_index(parts).ok_or(AppError::NoParticipantsLeft)?;

        let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;

        parts[picked_idx].removed = true;
        parts[picked_idx].removed_at = Some(chrono::Utc::now());
        parts[picked_idx].spin_order = Some(spin_order);

        let remaining = parts.iter().filter(|p| !p.removed).count();
        let picked = parts[picked_idx].clone();

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
}
