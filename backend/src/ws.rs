use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
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

    #[serde(rename = "participant_updated")]
    ParticipantUpdated { participant: Participant },

    #[serde(rename = "spin_result")]
    SpinResult {
        picked: Participant,
        remaining: usize,
    },

    #[serde(rename = "session_reset")]
    SessionReset { participants: Vec<Participant> },
}

type Channels = Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>;

/// Manages per-session broadcast channels.
#[derive(Debug, Clone, Default)]
pub struct Hub {
    channels: Channels,
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

    /// Subscribe to a session's events. Returns a guard that yields the
    /// receiver and removes the session's channel entry once the last
    /// subscriber drops it, so the channels map does not leak.
    pub async fn subscribe(&self, session_id: &str) -> Subscription {
        let rx = self.get_tx(session_id).await.subscribe();
        Subscription {
            channels: Arc::clone(&self.channels),
            session_id: session_id.to_string(),
            rx: Some(rx),
        }
    }

    /// Broadcast an event to all subscribers of a session.
    pub async fn broadcast(&self, session_id: &str, event: SessionEvent) {
        let tx = self.get_tx(session_id).await;
        let json = serde_json::to_string(&event).unwrap_or_default();
        // Ignore error — means no active receivers.
        let _ = tx.send(json);
    }

    /// Number of live session channels. Test/diagnostic helper.
    #[cfg(test)]
    pub async fn channel_count(&self) -> usize {
        self.channels.read().await.len()
    }
}

/// A live subscription to a session channel. Derefs to the underlying
/// broadcast receiver; on drop it tears down the session's channel entry
/// when no other subscribers remain.
#[derive(Debug)]
pub struct Subscription {
    channels: Channels,
    session_id: String,
    // Always `Some` until `Drop` takes it to release the receiver before
    // the live-count check.
    rx: Option<broadcast::Receiver<String>>,
}

impl Deref for Subscription {
    type Target = broadcast::Receiver<String>;

    fn deref(&self) -> &Self::Target {
        self.rx.as_ref().expect("subscription receiver is live")
    }
}

impl DerefMut for Subscription {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.rx.as_mut().expect("subscription receiver is live")
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // Release our receiver first so it is not counted as live below.
        drop(self.rx.take());

        let channels = Arc::clone(&self.channels);
        let session_id = std::mem::take(&mut self.session_id);

        // Cleanup must run under the write lock to stay correct against a
        // concurrent subscribe/broadcast. We re-check the live receiver
        // count while holding the lock and only remove an entry that still
        // has no remaining receivers, so a subscriber that arrives between
        // our drop and this task keeps its channel.
        tokio::spawn(async move {
            let mut guard = channels.write().await;
            if let Some(tx) = guard.get(&session_id) {
                if tx.receiver_count() == 0 {
                    guard.remove(&session_id);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run pending spawned cleanup tasks to completion. The cleanup task only
    /// awaits the channels lock, so a couple of yields drain it.
    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn last_subscriber_drop_removes_channel() {
        let hub = Hub::new();
        let sub = hub.subscribe("s1").await;
        assert_eq!(hub.channel_count().await, 1);

        drop(sub);
        settle().await;

        assert_eq!(hub.channel_count().await, 0);
    }

    #[tokio::test]
    async fn channel_survives_until_last_subscriber_leaves() {
        let hub = Hub::new();
        let a = hub.subscribe("s1").await;
        let b = hub.subscribe("s1").await;
        assert_eq!(hub.channel_count().await, 1);

        drop(a);
        settle().await;
        // One subscriber remains, so the entry must stay.
        assert_eq!(hub.channel_count().await, 1);

        drop(b);
        settle().await;
        assert_eq!(hub.channel_count().await, 0);
    }

    #[tokio::test]
    async fn resubscribe_during_cleanup_keeps_channel() {
        // A new subscriber arriving while a stale entry is around must not
        // have its channel removed by the departing subscriber's cleanup.
        let hub = Hub::new();
        let first = hub.subscribe("s1").await;

        drop(first);
        // Re-subscribe before letting the cleanup task run. The cleanup
        // re-checks the live receiver count under the lock, sees this new
        // receiver, and leaves the entry in place.
        let second = hub.subscribe("s1").await;
        settle().await;

        assert_eq!(hub.channel_count().await, 1);

        drop(second);
        settle().await;
        assert_eq!(hub.channel_count().await, 0);
    }

    #[tokio::test]
    async fn distinct_sessions_are_independent() {
        let hub = Hub::new();
        let a = hub.subscribe("a").await;
        let b = hub.subscribe("b").await;
        assert_eq!(hub.channel_count().await, 2);

        drop(a);
        settle().await;
        assert_eq!(hub.channel_count().await, 1);

        drop(b);
        settle().await;
        assert_eq!(hub.channel_count().await, 0);
    }
}
