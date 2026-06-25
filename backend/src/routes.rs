use axum::routing::{delete, get, patch, post};
use axum::Router;

use crate::store::AppState;
use crate::handlers;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(handlers::health))
        .route("/api/v1/sessions", post(handlers::create_session))
        .route("/api/v1/sessions/{id}", get(handlers::get_session))
        .route(
            "/api/v1/sessions/{id}/participants",
            post(handlers::add_participant),
        )
        .route(
            "/api/v1/sessions/{id}/participants/batch",
            post(handlers::add_participants_batch),
        )
        .route(
            "/api/v1/sessions/{id}/participants/{pid}",
            delete(handlers::delete_participant),
        )
        .route("/api/v1/sessions/{id}/spin", post(handlers::spin))
        .route("/api/v1/sessions/{id}/reset", post(handlers::reset_session))
        .route("/api/v1/sessions/{id}/ws", get(handlers::session_ws))
        // Editor features (weights, history, inspector) - additive from design iters
        .route(
            "/api/v1/sessions/{id}/participants/{pid}/props",
            post(handlers::update_participant_props),
        )
        .route(
            "/api/v1/sessions/{id}/participants/{pid}/props",
            patch(handlers::update_participant_props),
        )
        .route("/api/v1/sessions/{id}/actions", get(handlers::list_actions))
        .route("/api/v1/sessions/{id}/snapshot", get(handlers::get_snapshot))
        .route("/api/v1/sessions/{id}/restore", post(handlers::restore_from_snapshot))
        .with_state(state)
}
