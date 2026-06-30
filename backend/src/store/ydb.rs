//! EXPERIMENTAL YDB-backed store targeting the tables from
//! infra/ydb-schema.sql. Compile-verified against ydb 0.13, but not yet
//! exercised against a live YDB instance. Compiled only with `--features ydb`.

use std::sync::Arc;

use async_trait::async_trait;

use crate::error::AppError;
use crate::models::{Action, Participant, SegmentVisual, Session, Snapshot, SpinResult};

use super::{choose_weighted_active_index, Store};

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
    let pinned: Option<bool> = row.remove_field_by_name("pinned")?.try_into()?;
    let weight: Option<u32> = row.remove_field_by_name("weight")?.try_into()?;

    Ok(Participant {
        id: id.unwrap_or_default(),
        session_id: session_id.unwrap_or_default(),
        name: name.unwrap_or_default(),
        removed: removed.unwrap_or(false),
        removed_at: removed_at.map(chrono::DateTime::<chrono::Utc>::from),
        spin_order,
        pinned: pinned.unwrap_or(false),
        weight: weight.unwrap_or(1),
        visual: None,
    })
}

const SELECT_PARTICIPANTS: &str = "
    DECLARE $session_id AS Utf8;
    SELECT session_id, id, name, removed, removed_at, spin_order, pinned, weight
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

#[async_trait]
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
        let outcome = self
            .table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                let participants = participants.clone();
                async move {
                    if !Self::session_exists_in_tx(&mut t, &session_id).await? {
                        return Ok(TxOutcome::SessionNotFound);
                    }
                    for p in &participants {
                        t.query(
                            ydb::Query::new(
                                "
                                DECLARE $session_id AS Utf8;
                                DECLARE $id AS Utf8;
                                DECLARE $name AS Utf8;
                                DECLARE $removed AS Bool;
                                DECLARE $pinned AS Bool;
                                DECLARE $weight AS Uint32;
                                UPSERT INTO participants
                                    (session_id, id, name, removed, removed_at, spin_order, pinned, weight)
                                VALUES ($session_id, $id, $name, $removed, NULL, NULL, $pinned, $weight);
                                ",
                            )
                            .with_params(ydb::ydb_params!(
                                "$session_id" => session_id.clone(),
                                "$id" => p.id.clone(),
                                "$name" => p.name.clone(),
                                "$removed" => p.removed,
                                "$pinned" => p.pinned,
                                "$weight" => p.weight
                            )),
                        )
                        .await?;
                    }
                    t.commit().await?;
                    Ok(TxOutcome::Ok(()))
                }
            })
            .await
            .map_err(ydb_err)?;
        outcome.into_result()
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

    async fn update_participant(
        &self,
        session_id: &str,
        participant_id: &str,
        name: Option<String>,
        pinned: Option<bool>,
        weight: Option<u32>,
    ) -> Result<Participant, AppError> {
        let session_id = session_id.to_string();
        let participant_id = participant_id.to_string();
        let outcome = self
            .table_client()
            .retry_transaction(|mut t| {
                let session_id = session_id.clone();
                let participant_id = participant_id.clone();
                let name = name.clone();
                async move {
                    if !Self::session_exists_in_tx(&mut t, &session_id).await? {
                        return Ok(TxOutcome::SessionNotFound);
                    }
                    let parts = Self::participants_in_tx(&mut t, &session_id).await?;
                    let Some(mut participant) = parts.into_iter().find(|p| p.id == participant_id)
                    else {
                        return Ok(TxOutcome::ParticipantNotFound);
                    };
                    if let Some(name) = name {
                        participant.name = name;
                    }
                    if let Some(pinned) = pinned {
                        participant.pinned = pinned;
                    }
                    if let Some(weight) = weight {
                        participant.weight = weight;
                    }

                    t.query(
                        ydb::Query::new(
                            "
                            DECLARE $session_id AS Utf8;
                            DECLARE $id AS Utf8;
                            DECLARE $name AS Utf8;
                            DECLARE $pinned AS Bool;
                            DECLARE $weight AS Uint32;
                            UPDATE participants
                            SET name = $name,
                                pinned = $pinned,
                                weight = $weight
                            WHERE session_id = $session_id AND id = $id;
                            ",
                        )
                        .with_params(ydb::ydb_params!(
                            "$session_id" => session_id,
                            "$id" => participant_id,
                            "$name" => participant.name.clone(),
                            "$pinned" => participant.pinned,
                            "$weight" => participant.weight
                        )),
                    )
                    .await?;
                    t.commit().await?;
                    Ok(TxOutcome::Ok(participant))
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

                    let Some(picked_idx) = choose_weighted_active_index(&parts) else {
                        return Ok(TxOutcome::NoActiveParticipants);
                    };

                    let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;
                    let mut picked = parts[picked_idx].clone();
                    picked.removed = true;
                    picked.removed_at = Some(chrono::Utc::now());
                    picked.spin_order = Some(spin_order);
                    let remaining = parts.iter().filter(|p| !p.removed).count() - 1;

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
                    let parts = {
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
                        // Read back the restored rows inside the same transaction
                        // so the returned list reflects the committed reset.
                        Self::participants_in_tx(&mut t, &session_id).await?
                    };
                    t.commit().await?;
                    Ok(TxOutcome::Ok(parts))
                }
            })
            .await
            .map_err(ydb_err)?;
        outcome.into_result()
    }

    async fn update_participant_props(
        &self,
        _session_id: &str,
        _participant_id: &str,
        _weight: Option<f32>,
        _visual: Option<SegmentVisual>,
    ) -> Result<Participant, AppError> {
        Err(AppError::Internal(
            "update_participant_props not yet in ydb (memory first)".into(),
        ))
    }

    async fn append_action(&self, _action: &Action) -> Result<(), AppError> {
        Ok(())
    }
    async fn list_actions(
        &self,
        _session_id: &str,
        _limit: usize,
    ) -> Result<Vec<Action>, AppError> {
        Ok(vec![])
    }

    async fn create_snapshot(&self, _snapshot: &Snapshot) -> Result<(), AppError> {
        Ok(())
    }
    async fn get_snapshot(
        &self,
        _session_id: &str,
        _before_action_id: Option<&str>,
    ) -> Result<Option<Snapshot>, AppError> {
        Ok(None)
    }

    async fn restore_from_snapshot(
        &self,
        _session_id: &str,
        _participants: &[Participant],
    ) -> Result<Vec<Participant>, AppError> {
        Err(AppError::Internal(
            "restore_from_snapshot not yet in ydb".into(),
        ))
    }
}
