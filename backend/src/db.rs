use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::models::{Participant, Session};
use crate::ws::Hub;

/// In-memory storage for local development.
/// Will be replaced with YDB client for production.
#[derive(Debug, Clone, Default)]
pub struct AppState {
    pub sessions: Arc<RwLock<HashMap<String, Session>>>,
    pub participants: Arc<RwLock<HashMap<String, Vec<Participant>>>>,
    pub hub: Hub,
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
