use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MIN_PARTICIPANT_WEIGHT: u32 = 1;
pub const MAX_PARTICIPANT_WEIGHT: u32 = 5;

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
    pub pinned: bool,
    pub weight: u32,
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

#[derive(Debug, Deserialize)]
pub struct UpdateParticipantRequest {
    pub name: Option<String>,
    pub pinned: Option<bool>,
    pub weight: Option<u32>,
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
            pinned: false,
            weight: MIN_PARTICIPANT_WEIGHT,
        }
    }

    pub fn effective_weight(&self) -> u32 {
        self.weight
            .clamp(MIN_PARTICIPANT_WEIGHT, MAX_PARTICIPANT_WEIGHT)
    }
}
