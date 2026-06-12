use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::db::{AppState, Store};
use crate::error::AppError;
use crate::models::*;
use crate::ws::SessionEvent;

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
    if req.title.trim().is_empty() {
        return Err(AppError::BadRequest("Title cannot be empty".into()));
    }

    let session = Session::new(req.title.trim().to_string());
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
    if req.name.trim().is_empty() {
        return Err(AppError::BadRequest("Name cannot be empty".into()));
    }

    ensure_session_exists(&state, &session_id).await?;

    let participant = Participant::new(session_id.clone(), req.name.trim().to_string());

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

    ensure_session_exists(&state, &session_id).await?;

    let mut new_participants = Vec::new();
    for name in &req.names {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            new_participants.push(Participant::new(session_id.clone(), trimmed.to_string()));
        }
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

    let rx = state.hub.subscribe(&session_id).await;

    Ok(ws.on_upgrade(move |socket| handle_ws(socket, rx)))
}

async fn handle_ws(mut socket: WebSocket, mut rx: tokio::sync::broadcast::Receiver<String>) {
    loop {
        tokio::select! {
            msg = rx.recv() => {
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
