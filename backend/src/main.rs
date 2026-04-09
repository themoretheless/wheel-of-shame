mod db;
mod error;
mod handlers;
mod models;
mod routes;
mod ws;

use std::env;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let state = db::AppState::new();
    let app = routes::create_router(state).layer(cors);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("Server listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
