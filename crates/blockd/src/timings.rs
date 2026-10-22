//! Milliseconds per phase of an operation, in the order they ran: every
//! reply that does real work says where its time went.

use std::time::Instant;

#[derive(Debug, Default, Clone)]
pub struct Timings(Vec<(&'static str, f64)>);

impl Timings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs `f`, recording how long it took as `phase` (added to any time
    /// already recorded for it).
    pub fn time<T>(&mut self, phase: &'static str, f: impl FnOnce() -> T) -> T {
        let started = Instant::now();
        let value = f();
        self.add(phase, started.elapsed().as_secs_f64() * 1000.0);
        value
    }

    pub fn add(&mut self, phase: &'static str, ms: f64) {
        match self.0.iter_mut().find(|(name, _)| *name == phase) {
            Some((_, total)) => *total += ms,
            None => self.0.push((phase, ms)),
        }
    }

    pub fn extend(&mut self, other: &Timings) {
        for (phase, ms) in &other.0 {
            self.add(phase, *ms);
        }
    }
}

impl serde::Serialize for Timings {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (phase, ms) in &self.0 {
            map.serialize_entry(phase, &((ms * 10.0).round() / 10.0))?;
        }
        map.end()
    }
}
