//! Storage abstraction.
//!
//! [`Store`] is the backend-agnostic repository interface the HTTP handlers
//! depend on. Concrete backends live in their own submodules and are selected
//! at runtime by [`build_store_from_env`]. Adding a new backend means writing
//! one `impl Store` in a new module and wiring it into the factory; the
//! handlers never change.

use std::sync::Arc;

use async_trait::async_trait;
use rand::RngExt;

use crate::error::AppError;
use crate::models::{Action, Participant, SegmentVisual, Session, Snapshot, SpinResult};
use crate::ws::Hub;

mod memory;
pub use memory::MemoryStore;

#[cfg(feature = "sqlite")]
mod sqlite;
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteStore;

#[cfg(feature = "ydb")]
mod ydb;
#[cfg(feature = "ydb")]
pub use ydb::YdbStore;

/// Persistent storage abstraction over sessions and participants.
///
/// Covers exactly the operations the HTTP handlers need. Spin and reset are
/// store-level operations so that a database backend can perform them
/// transactionally.
///
/// The trait is object-safe (`Arc<dyn Store>`) so the concrete backend is a
/// runtime choice, not a compile-time type threaded through the app.
#[async_trait]
pub trait Store: Send + Sync {
    async fn create_session(&self, session: &Session) -> Result<(), AppError>;
    async fn get_session(&self, id: &str) -> Result<Option<Session>, AppError>;
    async fn list_participants(&self, session_id: &str) -> Result<Vec<Participant>, AppError>;
    /// Append participants to an existing session.
    async fn add_participants(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<(), AppError>;
    async fn delete_participant(
        &self,
        session_id: &str,
        participant_id: &str,
    ) -> Result<(), AppError>;
    async fn update_participant(
        &self,
        session_id: &str,
        participant_id: &str,
        name: Option<String>,
        pinned: Option<bool>,
        weight: Option<u32>,
    ) -> Result<Participant, AppError>;
    /// Pick a random active participant, mark it removed and return it
    /// together with the number of remaining active participants.
    async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError>;
    /// Restore all participants of a session to the active state.
    /// Returns the restored participant list.
    async fn reset_session(&self, session_id: &str) -> Result<Vec<Participant>, AppError>;

    /// Update weight and/or visual for one participant (idempotent, additive).
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
    async fn get_snapshot(
        &self,
        session_id: &str,
        before_action_id: Option<&str>,
    ) -> Result<Option<Snapshot>, AppError>;

    /// Replace the entire participant list for a session (used by snapshot restore for undo).
    /// Returns the new list. Does not append action (caller does).
    async fn restore_from_snapshot(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<Vec<Participant>, AppError>;
}

pub(crate) fn choose_weighted_active_index(parts: &[Participant]) -> Option<usize> {
    let active: Vec<(usize, f32)> = parts
        .iter()
        .enumerate()
        .filter(|(_, p)| !p.removed)
        .map(|(idx, p)| (idx, p.effective_weight()))
        .collect();
    let total_weight: f32 = active.iter().map(|(_, weight)| *weight).sum();
    if total_weight <= 0.0 {
        return None;
    }

    let mut ticket = rand::rng().random_range(0.0..total_weight);
    for (idx, weight) in active {
        if ticket < weight {
            return Some(idx);
        }
        ticket -= weight;
    }
    None
}

/// Runtime-selected storage backend shared across the app.
pub type DynStore = Arc<dyn Store>;

/// Shared application state: storage backend plus the WebSocket hub.
#[derive(Clone)]
pub struct AppState {
    pub store: DynStore,
    pub hub: Hub,
}

impl AppState {
    pub fn new(store: DynStore) -> Self {
        Self {
            store,
            hub: Hub::new(),
        }
    }

    /// Convenience constructor for local development and tests.
    pub fn in_memory() -> Self {
        Self::new(Arc::new(MemoryStore::default()))
    }
}

/// Build the storage backend from environment configuration.
///
/// Selection order:
/// 1. `STORE_BACKEND` = `memory` | `sqlite` | `ydb` (explicit wins).
/// 2. Otherwise `YDB_CONNECTION_STRING` selects YDB (back-compat).
/// 3. Otherwise `DATABASE_URL` / `SQLITE_PATH` selects SQLite.
/// 4. Otherwise in-memory.
pub async fn build_store_from_env() -> Result<DynStore, AppError> {
    match std::env::var("STORE_BACKEND").ok().as_deref() {
        Some("memory") => {
            tracing::info!("storage: in-memory");
            Ok(Arc::new(MemoryStore::default()))
        }
        Some("sqlite") => build_sqlite().await,
        Some("ydb") => build_ydb().await,
        Some(other) => Err(AppError::Internal(format!(
            "unknown STORE_BACKEND '{other}' (expected memory|sqlite|ydb)"
        ))),
        None => {
            if std::env::var("YDB_CONNECTION_STRING").is_ok() {
                build_ydb().await
            } else if std::env::var("DATABASE_URL").is_ok() || std::env::var("SQLITE_PATH").is_ok()
            {
                build_sqlite().await
            } else {
                tracing::info!("storage: in-memory (default; set STORE_BACKEND to persist)");
                Ok(Arc::new(MemoryStore::default()))
            }
        }
    }
}

#[cfg(feature = "sqlite")]
async fn build_sqlite() -> Result<DynStore, AppError> {
    let url = std::env::var("DATABASE_URL")
        .ok()
        .or_else(|| {
            std::env::var("SQLITE_PATH")
                .ok()
                .map(|p| format!("sqlite://{p}"))
        })
        .unwrap_or_else(|| "sqlite://wheel.db".to_string());
    tracing::info!("storage: sqlite ({url})");
    Ok(Arc::new(SqliteStore::connect(&url).await?))
}

#[cfg(not(feature = "sqlite"))]
async fn build_sqlite() -> Result<DynStore, AppError> {
    Err(AppError::Internal(
        "sqlite backend requested but not compiled in (build with --features sqlite)".into(),
    ))
}

#[cfg(feature = "ydb")]
async fn build_ydb() -> Result<DynStore, AppError> {
    let connection_string = std::env::var("YDB_CONNECTION_STRING")
        .map_err(|_| AppError::Internal("ydb backend requires YDB_CONNECTION_STRING".into()))?;
    tracing::warn!("storage: YDB (experimental), connecting via YDB_CONNECTION_STRING");
    Ok(Arc::new(YdbStore::connect(&connection_string).await?))
}

#[cfg(not(feature = "ydb"))]
async fn build_ydb() -> Result<DynStore, AppError> {
    Err(AppError::Internal(
        "ydb backend requested but not compiled in (build with --features ydb)".into(),
    ))
}
