use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use rand::prelude::IndexedRandom;

use crate::db::AppState;
use crate::error::AppError;
use crate::models::*;
use crate::ws::SessionEvent;

pub async fn health() -> &'static str {
    "ok"
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<Session>), AppError> {
    if req.title.trim().is_empty() {
        return Err(AppError::BadRequest("Title cannot be empty".into()));
    }

    let session = Session::new(req.title.trim().to_string());
    let id = session.id.clone();

    state.sessions.write().await.insert(id.clone(), session.clone());
    state.participants.write().await.insert(id, vec![]);

    Ok((StatusCode::CREATED, Json(session)))
}

pub async fn get_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let sessions = state.sessions.read().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound("Session not found".into()))?
        .clone();

    let participants = state.participants.read().await;
    let parts = participants.get(&session_id).cloned().unwrap_or_default();

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

    let sessions = state.sessions.read().await;
    if !sessions.contains_key(&session_id) {
        return Err(AppError::NotFound("Session not found".into()));
    }
    drop(sessions);

    let participant = Participant::new(session_id.clone(), req.name.trim().to_string());
    let result = participant.clone();

    state
        .participants
        .write()
        .await
        .entry(session_id.clone())
        .or_default()
        .push(participant.clone());

    state
        .hub
        .broadcast(&session_id, SessionEvent::ParticipantAdded { participant })
        .await;

    Ok((StatusCode::CREATED, Json(result)))
}

pub async fn add_participants_batch(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<AddParticipantsBatchRequest>,
) -> Result<(StatusCode, Json<Vec<Participant>>), AppError> {
    if req.names.is_empty() {
        return Err(AppError::BadRequest("Names list cannot be empty".into()));
    }

    let sessions = state.sessions.read().await;
    if !sessions.contains_key(&session_id) {
        return Err(AppError::NotFound("Session not found".into()));
    }
    drop(sessions);

    let mut new_participants = Vec::new();
    for name in &req.names {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            new_participants.push(Participant::new(session_id.clone(), trimmed.to_string()));
        }
    }

    let result = new_participants.clone();

    state
        .participants
        .write()
        .await
        .entry(session_id.clone())
        .or_default()
        .extend(new_participants.clone());

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::ParticipantsAdded {
                participants: new_participants,
            },
        )
        .await;

    Ok((StatusCode::CREATED, Json(result)))
}

pub async fn delete_participant(
    State(state): State<AppState>,
    Path((session_id, participant_id)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let mut participants = state.participants.write().await;
    let parts = participants
        .get_mut(&session_id)
        .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

    let idx = parts
        .iter()
        .position(|p| p.id == participant_id)
        .ok_or_else(|| AppError::NotFound("Participant not found".into()))?;

    parts.remove(idx);
    drop(participants);

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
    let mut participants = state.participants.write().await;
    let parts = participants
        .get_mut(&session_id)
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
    drop(participants);

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::SpinResult {
                picked: picked.clone(),
                remaining,
            },
        )
        .await;

    Ok(Json(SpinResult { picked, remaining }))
}

pub async fn reset_session(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, AppError> {
    let mut participants = state.participants.write().await;
    let parts = participants
        .get_mut(&session_id)
        .ok_or_else(|| AppError::NotFound("Session not found".into()))?;

    for p in parts.iter_mut() {
        p.removed = false;
        p.removed_at = None;
        p.spin_order = None;
    }

    let reset_parts = parts.clone();
    drop(participants);

    state
        .hub
        .broadcast(
            &session_id,
            SessionEvent::SessionReset {
                participants: reset_parts,
            },
        )
        .await;

    Ok(StatusCode::OK)
}

/// WebSocket endpoint: /api/v1/sessions/{id}/ws
pub async fn session_ws(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    // Verify session exists.
    let sessions = state.sessions.read().await;
    if !sessions.contains_key(&session_id) {
        return Err(AppError::NotFound("Session not found".into()));
    }
    drop(sessions);

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
