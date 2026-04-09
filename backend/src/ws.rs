use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

use crate::models::Participant;

/// Events broadcast to all WebSocket clients in a session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum SessionEvent {
    #[serde(rename = "participant_added")]
    ParticipantAdded { participant: Participant },

    #[serde(rename = "participants_added")]
    ParticipantsAdded { participants: Vec<Participant> },

    #[serde(rename = "participant_deleted")]
    ParticipantDeleted { participant_id: String },

    #[serde(rename = "spin_result")]
    SpinResult {
        picked: Participant,
        remaining: usize,
    },

    #[serde(rename = "session_reset")]
    SessionReset { participants: Vec<Participant> },
}

/// Manages per-session broadcast channels.
#[derive(Debug, Clone, Default)]
pub struct Hub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get or create a broadcast sender for a session.
    pub async fn get_tx(&self, session_id: &str) -> broadcast::Sender<String> {
        let channels = self.channels.read().await;
        if let Some(tx) = channels.get(session_id) {
            return tx.clone();
        }
        drop(channels);

        let mut channels = self.channels.write().await;
        // Double-check after acquiring write lock.
        if let Some(tx) = channels.get(session_id) {
            return tx.clone();
        }
        let (tx, _) = broadcast::channel(64);
        channels.insert(session_id.to_string(), tx.clone());
        tx
    }

    /// Subscribe to a session's events. Returns a receiver.
    pub async fn subscribe(&self, session_id: &str) -> broadcast::Receiver<String> {
        self.get_tx(session_id).await.subscribe()
    }

    /// Broadcast an event to all subscribers of a session.
    pub async fn broadcast(&self, session_id: &str, event: SessionEvent) {
        let tx = self.get_tx(session_id).await;
        let json = serde_json::to_string(&event).unwrap_or_default();
        // Ignore error — means no active receivers.
        let _ = tx.send(json);
    }
}
