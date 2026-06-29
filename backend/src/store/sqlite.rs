//! SQLite-backed store via sqlx. Compiled only with `--features sqlite`.
//!
//! Persists sessions and participants to a single SQLite database file, so
//! state survives restarts. Note: SQLite is single-writer and file-local, so
//! this backend is correct for a single process; it is not suitable for a
//! horizontally scaled deployment where instances would each open their own
//! file.

use std::str::FromStr;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;
use crate::models::{Participant, Session, SpinResult};

use super::{choose_weighted_active_index, Store};

#[derive(Clone)]
pub struct SqliteStore {
    pool: SqlitePool,
}

fn db_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Internal(format!("sqlite error: {e}"))
}

fn row_to_participant(row: &SqliteRow) -> Participant {
    let removed_at: Option<String> = row.get("removed_at");
    let spin_order: Option<i64> = row.get("spin_order");
    Participant {
        id: row.get("id"),
        session_id: row.get("session_id"),
        name: row.get("name"),
        removed: row.get::<bool, _>("removed"),
        removed_at: removed_at
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|d| d.with_timezone(&Utc)),
        spin_order: spin_order.map(|v| v as u32),
        pinned: row.get::<bool, _>("pinned"),
        weight: row.get::<i64, _>("weight") as u32,
    }
}

impl SqliteStore {
    /// Connect to (and if necessary create) the SQLite database at `url`,
    /// e.g. `sqlite://wheel.db` or `sqlite::memory:`. Creates the schema on
    /// first connection.
    pub async fn connect(url: &str) -> Result<Self, AppError> {
        // Every connection to `:memory:` opens its own private empty database,
        // so a multi-connection pool would run queries against databases that
        // never saw init_schema. Pin in-memory databases to a single
        // never-expiring connection.
        let is_memory = url.contains(":memory:");

        let mut opts = SqliteConnectOptions::from_str(url)
            .map_err(db_err)?
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(5));
        if !is_memory {
            // WAL lets readers proceed while a writer commits and avoids the
            // rollback-journal deadlock between two write transactions that
            // both hold shared read locks.
            opts = opts.journal_mode(SqliteJournalMode::Wal);
        }

        let mut pool_opts = SqlitePoolOptions::new();
        if is_memory {
            pool_opts = pool_opts
                .max_connections(1)
                .idle_timeout(None)
                .max_lifetime(None);
        } else {
            pool_opts = pool_opts.max_connections(5);
        }
        let pool = pool_opts.connect_with(opts).await.map_err(db_err)?;

        let store = Self { pool };
        store.init_schema().await?;
        Ok(store)
    }

    /// Build a store from an existing pool (used by tests).
    #[cfg(test)]
    pub async fn from_pool(pool: SqlitePool) -> Result<Self, AppError> {
        let store = Self { pool };
        store.init_schema().await?;
        Ok(store)
    }

    /// Begin a write transaction that takes the write lock upfront.
    ///
    /// A deferred (default) transaction that reads first and writes later
    /// cannot upgrade its read snapshot if another writer committed in
    /// between — SQLite fails the write immediately with SQLITE_BUSY and
    /// busy_timeout does not apply. BEGIN IMMEDIATE serializes writers at
    /// the start instead: the second writer waits (honoring busy_timeout)
    /// and then reads the already-updated state.
    async fn begin_write(&self) -> Result<sqlx::Transaction<'static, sqlx::Sqlite>, AppError> {
        self.pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db_err)
    }

    async fn init_schema(&self) -> Result<(), AppError> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL
            );",
        )
        .execute(&self.pool)
        .await
        .map_err(db_err)?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS participants (
                session_id TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                removed INTEGER NOT NULL DEFAULT 0,
                removed_at TEXT,
                spin_order INTEGER,
                pinned INTEGER NOT NULL DEFAULT 0,
                weight INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (session_id, id)
            );",
        )
        .execute(&self.pool)
        .await
        .map_err(db_err)?;

        self.ensure_participant_column("pinned", "INTEGER NOT NULL DEFAULT 0")
            .await?;
        self.ensure_participant_column("weight", "INTEGER NOT NULL DEFAULT 1")
            .await?;

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_participants_session
             ON participants(session_id);",
        )
        .execute(&self.pool)
        .await
        .map_err(db_err)?;

        Ok(())
    }

    async fn ensure_participant_column(
        &self,
        name: &str,
        definition: &str,
    ) -> Result<(), AppError> {
        let rows = sqlx::query("PRAGMA table_info(participants)")
            .fetch_all(&self.pool)
            .await
            .map_err(db_err)?;
        let exists = rows.iter().any(|row| row.get::<String, _>("name") == name);
        if !exists {
            sqlx::query(&format!(
                "ALTER TABLE participants ADD COLUMN {name} {definition}",
            ))
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        }
        Ok(())
    }
}

#[async_trait]
impl Store for SqliteStore {
    async fn create_session(&self, session: &Session) -> Result<(), AppError> {
        sqlx::query("INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)")
            .bind(&session.id)
            .bind(&session.title)
            .bind(session.created_at.to_rfc3339())
            .execute(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn get_session(&self, id: &str) -> Result<Option<Session>, AppError> {
        let row = sqlx::query("SELECT id, title, created_at FROM sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_err)?;

        Ok(row.map(|row| {
            let created_at: String = row.get("created_at");
            Session {
                id: row.get("id"),
                title: row.get("title"),
                created_at: DateTime::parse_from_rfc3339(&created_at)
                    .map(|d| d.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            }
        }))
    }

    async fn list_participants(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        let rows = sqlx::query(
            "SELECT session_id, id, name, removed, removed_at, spin_order, pinned, weight
             FROM participants WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(db_err)?;

        Ok(rows.iter().map(row_to_participant).collect())
    }

    async fn add_participants(
        &self,
        session_id: &str,
        participants: &[Participant],
    ) -> Result<(), AppError> {
        let mut tx = self.begin_write().await?;

        let exists = sqlx::query("SELECT 1 FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if exists.is_none() {
            return Err(AppError::NotFound("Session not found".into()));
        }

        for p in participants {
            sqlx::query(
                "INSERT OR REPLACE INTO participants
                    (session_id, id, name, removed, removed_at, spin_order, pinned, weight)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(session_id)
            .bind(&p.id)
            .bind(&p.name)
            .bind(p.removed)
            .bind(p.removed_at.map(|d| d.to_rfc3339()))
            .bind(p.spin_order.map(|v| v as i64))
            .bind(p.pinned)
            .bind(p.weight as i64)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        }

        tx.commit().await.map_err(db_err)?;
        Ok(())
    }

    async fn delete_participant(
        &self,
        session_id: &str,
        participant_id: &str,
    ) -> Result<(), AppError> {
        let mut tx = self.begin_write().await?;

        let session = sqlx::query("SELECT 1 FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if session.is_none() {
            return Err(AppError::NotFound("Session not found".into()));
        }

        let result = sqlx::query("DELETE FROM participants WHERE session_id = ? AND id = ?")
            .bind(session_id)
            .bind(participant_id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;

        if result.rows_affected() == 0 {
            return Err(AppError::NotFound("Participant not found".into()));
        }

        tx.commit().await.map_err(db_err)?;
        Ok(())
    }

    async fn update_participant(
        &self,
        session_id: &str,
        participant_id: &str,
        name: Option<String>,
        pinned: Option<bool>,
        weight: Option<u32>,
    ) -> Result<Participant, AppError> {
        let mut tx = self.begin_write().await?;

        let session = sqlx::query("SELECT 1 FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if session.is_none() {
            return Err(AppError::NotFound("Session not found".into()));
        }

        let row = sqlx::query(
            "SELECT session_id, id, name, removed, removed_at, spin_order, pinned, weight
             FROM participants WHERE session_id = ? AND id = ?",
        )
        .bind(session_id)
        .bind(participant_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
        let Some(row) = row else {
            return Err(AppError::NotFound("Participant not found".into()));
        };
        let mut participant = row_to_participant(&row);
        if let Some(name) = name {
            participant.name = name;
        }
        if let Some(pinned) = pinned {
            participant.pinned = pinned;
        }
        if let Some(weight) = weight {
            participant.weight = weight;
        }

        sqlx::query(
            "UPDATE participants
             SET name = ?, pinned = ?, weight = ?
             WHERE session_id = ? AND id = ?",
        )
        .bind(&participant.name)
        .bind(participant.pinned)
        .bind(participant.weight as i64)
        .bind(session_id)
        .bind(participant_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

        tx.commit().await.map_err(db_err)?;
        Ok(participant)
    }

    async fn spin(&self, session_id: &str) -> Result<SpinResult, AppError> {
        let mut tx = self.begin_write().await?;

        let session = sqlx::query("SELECT 1 FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if session.is_none() {
            return Err(AppError::NotFound("Session not found".into()));
        }

        let rows = sqlx::query(
            "SELECT session_id, id, name, removed, removed_at, spin_order, pinned, weight
             FROM participants WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        let parts: Vec<Participant> = rows.iter().map(row_to_participant).collect();

        let picked_idx =
            choose_weighted_active_index(&parts).ok_or(AppError::NoParticipantsLeft)?;

        let spin_order = parts.iter().filter(|p| p.removed).count() as u32 + 1;
        let mut picked = parts[picked_idx].clone();
        picked.removed = true;
        picked.removed_at = Some(Utc::now());
        picked.spin_order = Some(spin_order);
        let remaining = parts.iter().filter(|p| !p.removed).count() - 1;

        sqlx::query(
            "UPDATE participants
             SET removed = 1, removed_at = ?, spin_order = ?
             WHERE session_id = ? AND id = ?",
        )
        .bind(picked.removed_at.unwrap().to_rfc3339())
        .bind(spin_order as i64)
        .bind(session_id)
        .bind(&picked.id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

        tx.commit().await.map_err(db_err)?;
        Ok(SpinResult { picked, remaining })
    }

    async fn reset_session(&self, session_id: &str) -> Result<Vec<Participant>, AppError> {
        let mut tx = self.begin_write().await?;

        let session = sqlx::query("SELECT 1 FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if session.is_none() {
            return Err(AppError::NotFound("Session not found".into()));
        }

        sqlx::query(
            "UPDATE participants
             SET removed = 0, removed_at = NULL, spin_order = NULL
             WHERE session_id = ?",
        )
        .bind(session_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

        let rows = sqlx::query(
            "SELECT session_id, id, name, removed, removed_at, spin_order, pinned, weight
             FROM participants WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
        let parts: Vec<Participant> = rows.iter().map(row_to_participant).collect();

        tx.commit().await.map_err(db_err)?;
        Ok(parts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> SqliteStore {
        SqliteStore::connect("sqlite::memory:").await.unwrap()
    }

    #[tokio::test]
    async fn create_and_get_session() {
        let s = store().await;
        let session = Session::new("Test".into());
        s.create_session(&session).await.unwrap();
        let got = s.get_session(&session.id).await.unwrap().unwrap();
        assert_eq!(got.id, session.id);
        assert_eq!(got.title, "Test");
    }

    #[tokio::test]
    async fn add_to_missing_session_is_not_found() {
        let s = store().await;
        let p = Participant::new("nope".into(), "Alice".into());
        let err = s.add_participants("nope", std::slice::from_ref(&p)).await;
        assert!(matches!(err, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn spin_removes_until_empty_then_resets() {
        let s = store().await;
        let session = Session::new("Game".into());
        s.create_session(&session).await.unwrap();
        let parts: Vec<Participant> = ["a", "b", "c"]
            .iter()
            .map(|n| Participant::new(session.id.clone(), n.to_string()))
            .collect();
        s.add_participants(&session.id, &parts).await.unwrap();

        for expected_remaining in (0..3).rev() {
            let res = s.spin(&session.id).await.unwrap();
            assert_eq!(res.remaining, expected_remaining);
            assert!(res.picked.removed);
            assert!(res.picked.spin_order.is_some());
        }
        assert!(matches!(
            s.spin(&session.id).await,
            Err(AppError::NoParticipantsLeft)
        ));

        let restored = s.reset_session(&session.id).await.unwrap();
        assert_eq!(restored.len(), 3);
        assert!(restored
            .iter()
            .all(|p| !p.removed && p.spin_order.is_none()));
    }

    #[tokio::test]
    async fn delete_participant_paths() {
        let s = store().await;
        let session = Session::new("Game".into());
        s.create_session(&session).await.unwrap();
        let p = Participant::new(session.id.clone(), "a".into());
        s.add_participants(&session.id, std::slice::from_ref(&p))
            .await
            .unwrap();

        s.delete_participant(&session.id, &p.id).await.unwrap();
        assert!(matches!(
            s.delete_participant(&session.id, &p.id).await,
            Err(AppError::NotFound(_))
        ));
    }
}
