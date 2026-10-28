use std::collections::HashMap;

pub(crate) struct ConnectionInfo {
    pub is_initiator: bool,
    pub generation: u64,
}

pub(crate) struct ConnectionSet {
    by_public_key: HashMap<[u8; 32], ConnectionInfo>,
}

impl ConnectionSet {
    pub fn new() -> Self {
        Self {
            by_public_key: HashMap::new(),
        }
    }

    pub fn has(&self, public_key: &[u8; 32]) -> bool {
        self.by_public_key.contains_key(public_key)
    }

    pub fn get(&self, public_key: &[u8; 32]) -> Option<&ConnectionInfo> {
        self.by_public_key.get(public_key)
    }

    pub fn add(&mut self, public_key: [u8; 32], info: ConnectionInfo) {
        self.by_public_key.insert(public_key, info);
    }

    pub fn remove(&mut self, public_key: &[u8; 32]) -> bool {
        self.by_public_key.remove(public_key).is_some()
    }

    pub fn remove_generation(&mut self, public_key: &[u8; 32], generation: u64) -> bool {
        if self
            .by_public_key
            .get(public_key)
            .is_some_and(|info| info.generation == generation)
        {
            return self.remove(public_key);
        }
        false
    }

    pub fn len(&self) -> usize {
        self.by_public_key.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_has() {
        let mut set = ConnectionSet::new();
        let pk = [1u8; 32];
        assert!(!set.has(&pk));
        set.add(pk, ConnectionInfo { is_initiator: true,
                generation: 1,
            },
        );
        assert!(set.has(&pk));
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn remove() {
        let mut set = ConnectionSet::new();
        let pk = [2u8; 32];
        set.add(pk, ConnectionInfo { is_initiator: false,
                generation: 1,
            },
        );
        assert!(set.remove(&pk));
        assert!(!set.has(&pk));
        assert_eq!(set.len(), 0);
    }

    #[test]
    fn obsolete_session_cannot_release_replacement() {
        let mut set = ConnectionSet::new();
        let pk = [3; 32];
        set.add(
            pk,
            ConnectionInfo {
                is_initiator: false,
                generation: 1,
            },
        );
        set.add(
            pk,
            ConnectionInfo {
                is_initiator: false,
                generation: 2,
            },
        );
        assert!(!set.remove_generation(&pk, 1));
        assert!(set.has(&pk));
        assert!(set.remove_generation(&pk, 2));
        assert!(!set.has(&pk));
    }

    #[test]
    fn get_info() {
        let mut set = ConnectionSet::new();
        let pk = [3u8; 32];
        set.add(pk, ConnectionInfo { is_initiator: true,
                generation: 1,
            },
        );
        let info = set.get(&pk).expect("should exist");
        assert!(info.is_initiator);
    }
}
