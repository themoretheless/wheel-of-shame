use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::error::AppError;
use crate::models::*;
use crate::store::AppState;
use crate::ws::SessionEvent;

/// Maximum length, in characters, of a session title.
const MAX_TITLE_LEN: usize = 200;
/// Maximum length, in characters, of a participant name.
const MAX_NAME_LEN: usize = 100;
/// Maximum number of names accepted in a single batch request.
const MAX_BATCH_NAMES: usize = 500;

pub async fn health() -> &'static str {
    "ok"
}

async fn ensure_session_exists(state: &AppState, session_id: &str) -> Result<(), AppError> {
    if state.store.get_session(session_id).await?.is_none() {
        return Err(AppError::NotFound("Session not found".into()));
    }
    Ok(())
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<Session>), AppError> {
    let title = req.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("Title cannot be empty".into()));
    }
    if title.chars().count() > MAX_TITLE_LEN {
        return Err(AppError::BadRequest(format!(
            "Title must be at most {MAX_TITLE_LEN} characters"
        )));
    }

    let session = Session::new(title.to_string());
    state.store.create_session(&session).await?;

    Ok((StatusCode::CREATED, Json(session)))
}

pub async fn get_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = state
        .store
        .get_session(&session_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

    let parts = state.store.list_participants(&session_id).await?;

    Ok(Json(serde_json::json!({
        "session": session,
        "participants": parts,
    })))
}

pub async fn add_participant(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<AddParticipantRequest>,
) -> Result<(StatusCode, Json<Participant>), AppError> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Name cannot be empty".into()));
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(format!(
            "Name must be at most {MAX_NAME_LEN} characters"
        )));
    }

    ensure_session_exists(&state, &session_id).await?;

    let participant = Participant::new(session_id.clone(), name.to_string());

    state
        .store
        .add_participants(&session_id, std::slice::from_ref(&participant))
        .await?;

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::ParticipantAdded {
                participant: participant.clone(),
            },
        )
        .await;

    Ok((StatusCode::CREATED, Json(participant)))
}

pub async fn add_participants_batch(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<AddParticipantsBatchRequest>,
) -> Result<(StatusCode, Json<Vec<Participant>>), AppError> {
    if req.names.is_empty() {
        return Err(AppError::BadRequest("Names list cannot be empty".into()));
    }
    if req.names.len() > MAX_BATCH_NAMES {
        return Err(AppError::BadRequest(format!(
            "Cannot add more than {MAX_BATCH_NAMES} names at once"
        )));
    }

    ensure_session_exists(&state, &session_id).await?;

    let mut new_participants = Vec::new();
    for name in &req.names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > MAX_NAME_LEN {
            return Err(AppError::BadRequest(format!(
                "Name must be at most {MAX_NAME_LEN} characters"
            )));
        }
        new_participants.push(Participant::new(session_id.clone(), trimmed.to_string()));
    }

    state
        .store
        .add_participants(&session_id, &new_participants)
        .await?;

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::ParticipantsAdded {
                participants: new_participants.clone(),
            },
        )
        .await;

    Ok((StatusCode::CREATED, Json(new_participants)))
}

pub async fn delete_participant(
    State(state): State<AppState>,
    Path((session_id, participant_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    state
        .store
        .delete_participant(&session_id, &participant_id)
        .await?;

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::ParticipantDeleted {
                participant_id: participant_id.clone(),
            },
        )
        .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_participant(
    State(state): State<AppState>,
    Path((session_id, participant_id)): Path<(String, String)>,
    Json(req): Json<UpdateParticipantRequest>,
) -> Result<Json<Participant>, AppError> {
    let name = match req.name {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(AppError::BadRequest("Name cannot be empty".into()));
            }
            if trimmed.chars().count() > MAX_NAME_LEN {
                return Err(AppError::BadRequest(format!(
                    "Name must be at most {MAX_NAME_LEN} characters"
                )));
            }
            Some(trimmed.to_string())
        }
        None => None,
    };

    if name.is_none() && req.pinned.is_none() && req.weight.is_none() {
        return Err(AppError::BadRequest(
            "At least one participant setting is required".into(),
        ));
    }
    if let Some(weight) = req.weight {
        if !(MIN_PARTICIPANT_WEIGHT..=MAX_PARTICIPANT_WEIGHT).contains(&weight) {
            return Err(AppError::BadRequest(format!(
                "Weight must be between {MIN_PARTICIPANT_WEIGHT} and {MAX_PARTICIPANT_WEIGHT}"
            )));
        }
    }

    let participant = state
        .store
        .update_participant(&session_id, &participant_id, name, req.pinned, req.weight)
        .await?;

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::ParticipantUpdated {
                participant: participant.clone(),
            },
        )
        .await;

    Ok(Json(participant))
}

pub async fn spin(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<SpinResult>, AppError> {
    let result = state.store.spin(&session_id).await?;

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::SpinResult {
                picked: result.picked.clone(),
                remaining: result.remaining,
            },
        )
        .await;

    Ok(Json(result))
}

pub async fn reset_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let participants = state.store.reset_session(&session_id).await?;

    state
        .hub
        .broadcast(&session_id, SessionEvent::SessionReset { participants })
        .await;

    Ok(StatusCode::OK)
}

/// WebSocket endpoint: /api/v1/sessions/{id}/ws
pub async fn session_ws(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    ensure_session_exists(&state, &session_id).await?;

    let sub = state.hub.subscribe(&session_id).await;

    Ok(ws.on_upgrade(move |socket| handle_ws(socket, sub)))
}

async fn handle_ws(mut socket: WebSocket, mut sub: crate::ws::Subscription) {
    loop {
        tokio::select! {
            msg = sub.recv() => {
                match msg {
                    Ok(text) => {
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            ws_msg = socket.recv() => {
                match ws_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {} // ignore client messages
                }
            }
        }
    }
}

// Editor feature handlers (additive, from design iters 1-4)

#[derive(Debug, serde::Deserialize)]
pub struct UpdatePropsRequest {
    #[serde(default)]
    pub weight: Option<f32>,
    #[serde(default)]
    pub visual: Option<crate::models::SegmentVisual>,
}

pub async fn update_participant_props(
    State(state): State<AppState>,
    Path((session_id, pid)): Path<(String, String)>,
    Json(req): Json<UpdatePropsRequest>,
) -> Result<Json<Participant>, AppError> {
    ensure_session_exists(&state, &session_id).await?;
    // Server clamp + validation (0.1-10) per design
    let clamped_weight = req.weight.map(|w| w.clamp(0.1, 10.0));
    let participant = state
        .store
        .update_participant_props(&session_id, &pid, clamped_weight, req.visual.clone())
        .await?;

    // Log action(s) - support weight-only, visual-only or both (additive editor actions)
    if let Some(w) = clamped_weight {
        let wa = Action {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            kind: ActionKind::UpdateWeight {
                id: pid.clone(),
                weight: w,
            },
            timestamp: chrono::Utc::now(),
            actor: None,
        };
        let _ = state.store.append_action(&wa).await;
        state
            .hub
            .broadcast(&session_id, SessionEvent::ActionLogged { action: wa })
            .await;
    }
    if let Some(v) = req.visual.clone() {
        let va = Action {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            kind: ActionKind::UpdateVisual {
                id: pid.clone(),
                visual: v,
            },
            timestamp: chrono::Utc::now(),
            actor: None,
        };
        let _ = state.store.append_action(&va).await;
        state
            .hub
            .broadcast(&session_id, SessionEvent::ActionLogged { action: va })
            .await;
    }

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::SegmentUpdated {
                participant: participant.clone(),
            },
        )
        .await;

    Ok(Json(participant))
}

pub async fn list_actions(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Vec<Action>>, AppError> {
    ensure_session_exists(&state, &session_id).await?;
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    let actions = state.store.list_actions(&session_id, limit).await?;
    Ok(Json(actions))
}

#[derive(Debug, serde::Deserialize)]
pub struct SnapshotQuery {
    #[serde(default)]
    pub before: Option<String>,
}

pub async fn get_snapshot(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(q): Query<SnapshotQuery>,
) -> Result<Json<Option<Snapshot>>, AppError> {
    ensure_session_exists(&state, &session_id).await?;
    let snap = state
        .store
        .get_snapshot(&session_id, q.before.as_deref())
        .await?;
    Ok(Json(snap))
}

#[derive(Debug, serde::Deserialize)]
pub struct RestoreRequest {
    pub participants: Vec<Participant>,
}

pub async fn restore_from_snapshot(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<RestoreRequest>,
) -> Result<(StatusCode, Json<Vec<Participant>>), AppError> {
    ensure_session_exists(&state, &session_id).await?;
    let participants = state
        .store
        .restore_from_snapshot(&session_id, &req.participants)
        .await?;

    // Log compensating action
    let action = Action {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        kind: ActionKind::SnapshotRestored {
            snapshot_id: uuid::Uuid::new_v4().to_string(),
        },
        timestamp: chrono::Utc::now(),
        actor: None,
    };
    let _ = state.store.append_action(&action).await;

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::SnapshotRestored {
                participants: participants.clone(),
            },
        )
        .await;

    Ok((StatusCode::OK, Json(participants)))
}
