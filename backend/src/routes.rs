use axum::routing::{delete, get, post};
use axum::Router;

use crate::handlers;
use crate::store::AppState;

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
            delete(handlers::delete_participant).patch(handlers::update_participant),
        )
        .route("/api/v1/sessions/{id}/spin", post(handlers::spin))
        .route("/api/v1/sessions/{id}/reset", post(handlers::reset_session))
        .route("/api/v1/sessions/{id}/ws", get(handlers::session_ws))
        .with_state(state)
}
