//! Local explicit-metadata recommendations. No user comparisons, neighbors, ML or remote ranking.
pub mod database;
pub mod ranking;
pub mod taste;

#[cfg(test)]
pub(crate) mod tests;
