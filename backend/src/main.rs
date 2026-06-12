use std::env;
use tower_http::cors::{Any, CorsLayer};

use wheel_of_shame::db::{AnyStore, AppState, MemoryStore, YdbStore};
use wheel_of_shame::routes;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{port}");

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let store = match env::var("YDB_CONNECTION_STRING") {
        Ok(connection_string) => {
            tracing::warn!("storage: YDB (experimental), connecting via YDB_CONNECTION_STRING");
            let ydb = YdbStore::connect(&connection_string)
                .await
                .expect("failed to connect to YDB");
            AnyStore::Ydb(ydb)
        }
        Err(_) => {
            tracing::info!("storage: in-memory (set YDB_CONNECTION_STRING to use YDB)");
            AnyStore::Memory(MemoryStore::default())
        }
    };

    let state = AppState::new(store);
    let app = routes::create_router(state).layer(cors);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("Server listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
