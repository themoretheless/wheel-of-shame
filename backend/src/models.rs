use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Participant {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spin_order: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub title: String,
}

#[derive(Debug, Deserialize)]
pub struct AddParticipantRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct AddParticipantsBatchRequest {
    pub names: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct SpinResult {
    pub picked: Participant,
    pub remaining: usize,
}

impl Session {
    pub fn new(title: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            title,
            created_at: Utc::now(),
        }
    }
}

impl Participant {
    pub fn new(session_id: String, name: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            session_id,
            name,
            removed: false,
            removed_at: None,
            spin_order: None,
        }
    }
}
