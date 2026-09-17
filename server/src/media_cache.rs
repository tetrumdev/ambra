use bytes::Bytes;
use std::collections::{HashMap, VecDeque};

const MEDIA_CACHE_LIMIT_BYTES: usize = 128 * 1024 * 1024;

pub(crate) struct MediaCache {
    entries: HashMap<String, Bytes>,
    order: VecDeque<String>,
    size_bytes: usize,
    limit_bytes: usize,
}

impl Default for MediaCache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            size_bytes: 0,
            limit_bytes: MEDIA_CACHE_LIMIT_BYTES,
        }
    }
}

impl MediaCache {
    pub(crate) fn get(&mut self, key: &str) -> Option<Bytes> {
        let bytes = self.entries.get(key)?.clone();
        if let Some(index) = self.order.iter().position(|entry| entry == key) {
            let key = self.order.remove(index).unwrap();
            self.order.push_back(key);
        }
        Some(bytes)
    }

    pub(crate) fn insert(&mut self, key: String, bytes: Bytes) {
        if bytes.len() > self.limit_bytes || self.entries.contains_key(&key) {
            return;
        }
        while self.size_bytes.saturating_add(bytes.len()) > self.limit_bytes {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recently_replayed_audio_survives_eviction() {
        let mut cache = MediaCache {
            limit_bytes: 6,
            ..MediaCache::default()
        };
        cache.insert("first".into(), Bytes::from_static(b"123"));
        cache.insert("second".into(), Bytes::from_static(b"456"));
        assert!(cache.get("first").is_some());
        cache.insert("third".into(), Bytes::from_static(b"789"));
        assert!(cache.get("first").is_some());
        assert!(cache.get("second").is_none());
        assert_eq!(cache.size_bytes, 6);
        cache.insert("oversized".into(), Bytes::from_static(b"1234567"));
        assert_eq!(cache.size_bytes, 6);
    }
}
