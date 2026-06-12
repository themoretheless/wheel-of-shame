use std::env;
use std::process::ExitCode;

use tower_http::cors::{Any, CorsLayer};

use wheel_of_shame::routes;
use wheel_of_shame::store::{build_store_from_env, AppState};

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt::init();

    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let store = match build_store_from_env().await {
        Ok(store) => store,
        Err(err) => {
            tracing::error!("failed to initialize storage: {err:?}");
            return ExitCode::FAILURE;
        }
    };

    let state = AppState::new(store);
    let app = routes::create_router(state).layer(cors);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(err) => {
            tracing::error!("failed to bind {addr}: {err}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!("Server listening on {addr}");
    if let Err(err) = axum::serve(listener, app).await {
        tracing::error!("server error: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
