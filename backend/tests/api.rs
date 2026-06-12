use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use wheel_of_shame::store::AppState;
use wheel_of_shame::routes::create_router;

fn app() -> Router {
    create_router(AppState::in_memory())
}

async fn send(app: &Router, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    let body = match body {
        Some(json) => {
            builder = builder.header("content-type", "application/json");
            Body::from(json.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

async fn create_session(app: &Router, title: &str) -> String {
    let (status, body) = send(app, "POST", "/api/v1/sessions", Some(json!({ "title": title }))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["title"], title);
    body["id"].as_str().unwrap().to_string()
}

async fn get_participants(app: &Router, session_id: &str) -> Vec<Value> {
    let (status, body) = send(app, "GET", &format!("/api/v1/sessions/{session_id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    body["participants"].as_array().unwrap().clone()
}

#[tokio::test]
async fn create_session_returns_session() {
    let app = app();
    let id = create_session(&app, "Standup").await;

    let (status, body) = send(&app, "GET", &format!("/api/v1/sessions/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["session"]["id"], id);
    assert_eq!(body["session"]["title"], "Standup");
    assert_eq!(body["participants"], json!([]));
}

#[tokio::test]
async fn create_session_rejects_empty_title() {
    let app = app();
    let (status, body) = send(&app, "POST", "/api/v1/sessions", Some(json!({ "title": "  " }))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn add_single_participant() {
    let app = app();
    let id = create_session(&app, "Demo").await;

    let (status, body) = send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{id}/participants"),
        Some(json!({ "name": "Alice" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["name"], "Alice");
    assert_eq!(body["session_id"], id);
    assert_eq!(body["removed"], false);

    let parts = get_participants(&app, &id).await;
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["name"], "Alice");
}

#[tokio::test]
async fn add_participants_batch() {
    let app = app();
    let id = create_session(&app, "Demo").await;

    let (status, body) = send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{id}/participants/batch"),
        Some(json!({ "names": ["Alice", "  Bob ", "", "Carol"] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let returned: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(returned, ["Alice", "Bob", "Carol"]);

    let parts = get_participants(&app, &id).await;
    assert_eq!(parts.len(), 3);
}

#[tokio::test]
async fn spin_picks_active_participant_and_marks_removed() {
    let app = app();
    let id = create_session(&app, "Demo").await;
    send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{id}/participants/batch"),
        Some(json!({ "names": ["Alice", "Bob", "Carol"] })),
    )
    .await;

    let (status, body) = send(&app, "POST", &format!("/api/v1/sessions/{id}/spin"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["remaining"], 2);
    assert_eq!(body["picked"]["removed"], true);
    assert_eq!(body["picked"]["spin_order"], 1);
    let picked_name = body["picked"]["name"].as_str().unwrap().to_string();
    assert!(["Alice", "Bob", "Carol"].contains(&picked_name.as_str()));

    let parts = get_participants(&app, &id).await;
    let removed: Vec<&Value> = parts.iter().filter(|p| p["removed"] == true).collect();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0]["name"], picked_name);

    // Second spin must pick one of the remaining active participants.
    let (status, body) = send(&app, "POST", &format!("/api/v1/sessions/{id}/spin"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["remaining"], 1);
    assert_eq!(body["picked"]["spin_order"], 2);
    assert_ne!(body["picked"]["name"], picked_name);
}

#[tokio::test]
async fn spin_without_active_participants_returns_conflict() {
    let app = app();
    let id = create_session(&app, "Demo").await;
    send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{id}/participants"),
        Some(json!({ "name": "Alice" })),
    )
    .await;

    let (status, _) = send(&app, "POST", &format!("/api/v1/sessions/{id}/spin"), None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(&app, "POST", &format!("/api/v1/sessions/{id}/spin"), None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "No active participants left to pick");
}

#[tokio::test]
async fn reset_restores_all_participants() {
    let app = app();
    let id = create_session(&app, "Demo").await;
    send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{id}/participants/batch"),
        Some(json!({ "names": ["Alice", "Bob"] })),
    )
    .await;
    send(&app, "POST", &format!("/api/v1/sessions/{id}/spin"), None).await;
    send(&app, "POST", &format!("/api/v1/sessions/{id}/spin"), None).await;

    let (status, _) = send(&app, "POST", &format!("/api/v1/sessions/{id}/reset"), None).await;
    assert_eq!(status, StatusCode::OK);

    let parts = get_participants(&app, &id).await;
    assert_eq!(parts.len(), 2);
    for p in &parts {
        assert_eq!(p["removed"], false);
        assert!(p.get("removed_at").is_none());
        assert!(p.get("spin_order").is_none());
    }
}

#[tokio::test]
async fn unknown_session_returns_not_found() {
    let app = app();
    let (status, _) = send(&app, "GET", "/api/v1/sessions/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = send(&app, "POST", "/api/v1/sessions/nope/spin", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_participant_removes_it() {
    let app = app();
    let id = create_session(&app, "Demo").await;
    let (_, body) = send(
        &app,
        "POST",
        &format!("/api/v1/sessions/{id}/participants"),
        Some(json!({ "name": "Alice" })),
    )
    .await;
    let pid = body["id"].as_str().unwrap().to_string();

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/v1/sessions/{id}/participants/{pid}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    assert!(get_participants(&app, &id).await.is_empty());

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/v1/sessions/{id}/participants/{pid}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
