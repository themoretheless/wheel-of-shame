use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use rand::prelude::IndexedRandom;

use crate::error::AppError;
use crate::models::{Participant, Session, SpinResult};
use crate::ws::Hub;

/// Persistent storage abstraction over sessions and participants.
///
/// Covers exactly the operations the HTTP handlers need. Spin and reset are
/// store-level operations so that a database backend can perform them
/// transactionally.
#[allow(async_fn_in_trait)]
pub trait Store {
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
    /// Pick a random active participant, mark it removed and return it
    /// together with the number of remaining active participants.
    async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError>;
    /// Restore all participants of a session to the active state.
    /// Returns the restored participant list.
    async fn reset_session(&self, session_id: &str) -> Result<Vec<Participant>, AppError>;
}

/// Statically dispatched store used by the application.
#[derive(Clone)]
pub enum AnyStore {
    Memory(MemoryStore),
    Ydb(YdbStore),
}

impl Store for AnyStore {
    async fn create_session(&self, session: &Session) -> Result<(), AppError> {
        match self {
            AnyStore::Memory(s) => s.create_session(session).await,
            AnyStore::Ydb(s) => s.create_session(session).await,
        }
    }

    async fn get_session(&self, id: &str) -> Result<Option<Session>, AppError> {
        match self {
            AnyStore::Memory(s) => s.get_session(id).await,
            AnyStore::Ydb(s) => s.get_session(id).await,
        }
    }

    async fn list_participants(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        match self {
            AnyStore::Memory(s) => s.list_participants(session_id).await,
            AnyStore::Ydb(s) => s.list_participants(session_id).await,
        }
    }

    async fn add_participants(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<(), AppError> {
        match self {
            AnyStore::Memory(s) => s.add_participants(session_id, participants).await,
            AnyStore::Ydb(s) => s.add_participants(session_id, participants).await,
        }
    }

    async fn delete_participant(
        &self,
        session_id: &str,
        participant_id: &str,
    ) -> Result<(), AppError> {
        match self {
            AnyStore::Memory(s) => s.delete_participant(session_id, participant_id).await,
            AnyStore::Ydb(s) => s.delete_participant(session_id, participant_id).await,
        }
    }

    async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError> {
        match self {
            AnyStore::Memory(s) => s.spin(session_id).await,
            AnyStore::Ydb(s) => s.spin(session_id).await,
        }
    }

    async fn reset_session(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        match self {
            AnyStore::Memory(s) => s.reset_session(session_id).await,
            AnyStore::Ydb(s) => s.reset_session(session_id).await,
        }
    }
}

/// Shared application state: storage backend plus the WebSocket hub.
#[derive(Clone)]
pub struct AppState {
    pub store: AnyStore,
    pub hub: Hub,
}

impl AppState {
    pub fn new(store: AnyStore) -> Self {
        Self {
            store,
            hub: Hub::new(),
        }
    }

    /// Convenience constructor for local development and tests.
    pub fn in_memory() -> Self {
        Self::new(AnyStore::Memory(MemoryStore::default()))
    }
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/// In-memory storage for local development and tests.
#[derive(Debug, Clone, Default)]
pub struct MemoryStore {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    participants: Arc<RwLock<HashMap<String, Vec<Participant>>>>,
}

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

        let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;

        let picked_idx = *active.choose(&mut rand::rng()).unwrap();
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

// ---------------------------------------------------------------------------
// YDB store (experimental)
// ---------------------------------------------------------------------------

/// EXPERIMENTAL: YDB-backed store targeting the tables from
/// infra/ydb-schema.sql. Compile-verified against ydb 0.13, but not yet
/// exercised against a live YDB instance.
#[derive(Clone)]
pub struct YdbStore {
    client: Arc<ydb::Client>,
}

fn ydb_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Internal(format!("YDB error: {e}"))
}

/// Internal outcome of transactional operations that must distinguish
/// domain errors from YDB errors inside a retryable transaction.
enum TxOutcome<T> {
    Ok(T),
    SessionNotFound,
    ParticipantNotFound,
    NoActiveParticipants,
}

impl<T> TxOutcome<T> {
    fn into_result(self) -> Result<T, AppError> {
        match self {
            TxOutcome::Ok(v) => Ok(v),
            TxOutcome::SessionNotFound => Err(AppError::NotFound("Session not found".into())),
            TxOutcome::ParticipantNotFound => {
                Err(AppError::NotFound("Participant not found".into()))
            }
            TxOutcome::NoActiveParticipants => Err(AppError::NoParticipantsLeft),
        }
    }
}

fn participant_from_row(mut row: ydb::Row) -> Result<Participant, ydb::YdbError> {
    let id: Option<String> = row.remove_field_by_name("id")?.try_into()?;
    let session_id: Option<String> = row.remove_field_by_name("session_id")?.try_into()?;
    let name: Option<String> = row.remove_field_by_name("name")?.try_into()?;
    let removed: Option<bool> = row.remove_field_by_name("removed")?.try_into()?;
    let removed_at: Option<std::time::SystemTime> =
        row.remove_field_by_name("removed_at")?.try_into()?;
    let spin_order: Option<u32> = row.remove_field_by_name("spin_order")?.try_into()?;

    Ok(Participant {
        id: id.unwrap_or_default(),
        session_id: session_id.unwrap_or_default(),
        name: name.unwrap_or_default(),
        removed: removed.unwrap_or(false),
        removed_at: removed_at.map(chrono::DateTime::<chrono::Utc>::from),
        spin_order,
    })
}

const SELECT_PARTICIPANTS: &str = "
    DECLARE $session_id AS Utf8;
    SELECT session_id, id, name, removed, removed_at, spin_order
    FROM participants
    WHERE session_id = $session_id;
";

const SELECT_SESSION: &str = "
    DECLARE $id AS Utf8;
    SELECT id, title, created_at FROM sessions WHERE id = $id;
";

impl YdbStore {
    /// Connect using a YDB connection string
    /// (e.g. `grpc://localhost:2136?database=/local`). Credentials are
    /// resolved from the environment per YDB SDK conventions
    /// (YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS, YDB_ACCESS_TOKEN_CREDENTIALS,
    /// YDB_ANONYMOUS_CREDENTIALS, YDB_METADATA_CREDENTIALS).
    pub async fn connect(connection_string: &str) -> Result<Self, AppError> {
        let client = ydb::ClientBuilder::new_from_connection_string(connection_string)
            .map_err(ydb_err)?
            .with_credentials(ydb::FromEnvCredentials::new().map_err(ydb_err)?)
            .client()
            .map_err(ydb_err)?;
        client.wait().await.map_err(ydb_err)?;
        Ok(Self {
            client: Arc::new(client),
        })
    }

    fn table_client(&self) -> ydb::TableClient {
        self.client.table_client()
    }

    /// Check whether a session row exists, inside an open transaction.
    async fn session_exists_in_tx(
        t: &mut Box<dyn ydb::Transaction>,
        session_id: &str,
    ) -> ydb::YdbResult<bool> {
        let res = t
            .query(
                ydb::Query::new(SELECT_SESSION)
                    .with_params(ydb::ydb_params!("$id" => session_id.to_string())),
            )
            .await?;
        Ok(res.into_only_result()?.rows().next().is_some())
    }

    async fn participants_in_tx(
        t: &mut Box<dyn ydb::Transaction>,
        session_id: &str,
    ) -> ydb::YdbResult<Vec<Participant>> {
        let res = t
            .query(
                ydb::Query::new(SELECT_PARTICIPANTS)
                    .with_params(ydb::ydb_params!("$session_id" => session_id.to_string())),
            )
            .await?;
        res.into_only_result()?
            .rows()
            .map(participant_from_row)
            .collect()
    }
}

impl Store for YdbStore {
    async fn create_session(&self, session: &Session) -> Result<(), AppError> {
        let session = session.clone();
        self.table_client()
            .retry_transaction(|mut t| {
                let session = session.clone();
                async move {
                    t.query(
                        ydb::Query::new(
                            "
                            DECLARE $id AS Utf8;
                            DECLARE $title AS Utf8;
                            DECLARE $created_at AS Timestamp;
                            UPSERT INTO sessions (id, title, created_at)
                            VALUES ($id, $title, $created_at);
                            ",
                        )
                        .with_params(ydb::ydb_params!(
                            "$id" => session.id.clone(),
                            "$title" => session.title.clone(),
                            "$created_at" => std::time::SystemTime::from(session.created_at)
                        )),
                    )
                    .await?;
                    t.commit().await?;
                    Ok(())
                }
            })
            .await
            .map_err(ydb_err)
    }

    async fn get_session(&self, id: &str) -> Result<Option<Session>, AppError> {
        let id = id.to_string();
        self.table_client()
            .retry_transaction(|mut t| {
                let id = id.clone();
                async move {
                    let res = t
                        .query(
                            ydb::Query::new(SELECT_SESSION)
                                .with_params(ydb::ydb_params!("$id" => id)),
                        )
                        .await?;
                    let row = res.into_only_result()?.rows().next();
                    let Some(mut row) = row else {
                        return Ok(None);
                    };
                    let id: Option<String> = row.remove_field_by_name("id")?.try_into()?;
                    let title: Option<String> = row.remove_field_by_name("title")?.try_into()?;
                    let created_at: Option<std::time::SystemTime> =
                        row.remove_field_by_name("created_at")?.try_into()?;
                    Ok(Some(Session {
                        id: id.unwrap_or_default(),
                        title: title.unwrap_or_default(),
                        created_at: created_at
                            .map(chrono::DateTime::<chrono::Utc>::from)
                            .unwrap_or_else(chrono::Utc::now),
                    }))
                }
            })
            .await
            .map_err(ydb_err)
    }

    async fn list_participants(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        let session_id = session_id.to_string();
        self.table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                async move {
                    let parts = Self::participants_in_tx(&mut t, &session_id).await?;
                    Ok(parts)
                }
            })
            .await
            .map_err(ydb_err)
    }

    async fn add_participants(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<(), AppError> {
        let session_id = session_id.to_string();
        let participants = participants.to_vec();
        self.table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                let participants = participants.clone();
                async move {
                    for p in &participants {
                        t.query(
                            ydb::Query::new(
                                "
                                DECLARE $session_id AS Utf8;
                                DECLARE $id AS Utf8;
                                DECLARE $name AS Utf8;
                                DECLARE $removed AS Bool;
                                UPSERT INTO participants
                                    (session_id, id, name, removed, removed_at, spin_order)
                                VALUES ($session_id, $id, $name, $removed, NULL, NULL);
                                ",
                            )
                            .with_params(ydb::ydb_params!(
                                "$session_id" => session_id.clone(),
                                "$id" => p.id.clone(),
                                "$name" => p.name.clone(),
                                "$removed" => p.removed
                            )),
                        )
                        .await?;
                    }
                    t.commit().await?;
                    Ok(())
                }
            })
            .await
            .map_err(ydb_err)
    }

    async fn delete_participant(
        &self,
        session_id: &str,
        participant_id: &str,
    ) -> Result<(), AppError> {
        let session_id = session_id.to_string();
        let participant_id = participant_id.to_string();
        let outcome = self
            .table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                let participant_id = participant_id.clone();
                async move {
                    if !Self::session_exists_in_tx(&mut t, &session_id).await? {
                        return Ok(TxOutcome::SessionNotFound);
                    }
                    let res = t
                        .query(
                            ydb::Query::new(
                                "
                                DECLARE $session_id AS Utf8;
                                DECLARE $id AS Utf8;
                                SELECT id FROM participants
                                WHERE session_id = $session_id AND id = $id;
                                ",
                            )
                            .with_params(ydb::ydb_params!(
                                "$session_id" => session_id.clone(),
                                "$id" => participant_id.clone()
                            )),
                        )
                        .await?;
                    if res.into_only_result()?.rows().next().is_none() {
                        return Ok(TxOutcome::ParticipantNotFound);
                    }
                    t.query(
                        ydb::Query::new(
                            "
                            DECLARE $session_id AS Utf8;
                            DECLARE $id AS Utf8;
                            DELETE FROM participants
                            WHERE session_id = $session_id AND id = $id;
                            ",
                        )
                        .with_params(ydb::ydb_params!(
                            "$session_id" => session_id,
                            "$id" => participant_id
                        )),
                    )
                    .await?;
                    t.commit().await?;
                    Ok(TxOutcome::Ok(()))
                }
            })
            .await
            .map_err(ydb_err)?;
        outcome.into_result()
    }

    async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError> {
        let session_id = session_id.to_string();
        let outcome = self
            .table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                async move {
                    if !Self::session_exists_in_tx(&mut t, &session_id).await? {
                        return Ok(TxOutcome::SessionNotFound);
                    }
                    let parts = Self::participants_in_tx(&mut t, &session_id).await?;

                    let active: Vec<&Participant> =
                        parts.iter().filter(|p| !p.removed).collect();
                    if active.is_empty() {
                        return Ok(TxOutcome::NoActiveParticipants);
                    }

                    let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;
                    let mut picked = (*active.choose(&mut rand::rng()).unwrap()).clone();
                    picked.removed = true;
                    picked.removed_at = Some(chrono::Utc::now());
                    picked.spin_order = Some(spin_order);
                    let remaining = active.len() - 1;

                    t.query(
                        ydb::Query::new(
                            "
                            DECLARE $session_id AS Utf8;
                            DECLARE $id AS Utf8;
                            DECLARE $removed_at AS Timestamp;
                            DECLARE $spin_order AS Uint32;
                            UPDATE participants
                            SET removed = true,
                                removed_at = $removed_at,
                                spin_order = $spin_order
                            WHERE session_id = $session_id AND id = $id;
                            ",
                        )
                        .with_params(ydb::ydb_params!(
                            "$session_id" => session_id,
                            "$id" => picked.id.clone(),
                            "$removed_at" => std::time::SystemTime::from(picked.removed_at.unwrap()),
                            "$spin_order" => spin_order
                        )),
                    )
                    .await?;
                    t.commit().await?;
                    Ok(TxOutcome::Ok(SpinResult { picked, remaining }))
                }
            })
            .await
            .map_err(ydb_err)?;
        outcome.into_result()
    }

    async fn reset_session(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        let session_id = session_id.to_string();
        let outcome = self
            .table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                async move {
                    if !Self::session_exists_in_tx(&mut t, &session_id).await? {
                        return Ok(TxOutcome::SessionNotFound);
                    }
                    t.query(
                        ydb::Query::new(
                            "
                            DECLARE $session_id AS Utf8;
                            UPDATE participants
                            SET removed = false, removed_at = NULL, spin_order = NULL
                            WHERE session_id = $session_id;
                            ",
                        )
                        .with_params(ydb::ydb_params!("$session_id" => session_id.clone())),
                    )
                    .await?;
                    t.commit().await?;
                    Ok(TxOutcome::Ok(()))
                }
            })
            .await
            .map_err(ydb_err)?;
        outcome.into_result()?;
        self.list_participants(&session_id).await
    }
}
