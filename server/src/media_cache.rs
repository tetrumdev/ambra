use bytes::Bytes;
use std::collections::{HashMap, VecDeque};

const MEDIA_CACHE_LIMIT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct MediaCache {
    entries: HashMap<String, Bytes>,
    order: VecDeque<String>,
    size_bytes: usize,
}

impl MediaCache {
    pub(crate) fn get(&self, key: &str) -> Option<Bytes> {
        self.entries.get(key).cloned()
    }

    pub(crate) fn insert(&mut self, key: String, bytes: Bytes) {
        if bytes.len() > MEDIA_CACHE_LIMIT_BYTES || self.entries.contains_key(&key) {
            return;
        }
        while self.size_bytes.saturating_add(bytes.len()) > MEDIA_CACHE_LIMIT_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.size_bytes = self.size_bytes.saturating_sub(removed.len());
            }
        }
        self.size_bytes = self.size_bytes.saturating_add(bytes.len());
        self.order.push_back(key.clone());
        self.entries.insert(key, bytes);
    }
}
