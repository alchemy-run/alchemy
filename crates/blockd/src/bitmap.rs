use std::sync::atomic::{AtomicU64, Ordering};

/// One bit per block, safe to read and set from any thread.
pub(crate) struct Bitmap {
    words: Vec<AtomicU64>,
}

impl Bitmap {
    pub fn new(bits: u64) -> Self {
        Self {
            words: (0..bits.div_ceil(64)).map(|_| AtomicU64::new(0)).collect(),
        }
    }

    pub fn get(&self, bit: u64) -> bool {
        self.words[(bit / 64) as usize].load(Ordering::Acquire) & (1 << (bit % 64)) != 0
    }

    pub fn set(&self, bit: u64) {
        self.words[(bit / 64) as usize].fetch_or(1 << (bit % 64), Ordering::AcqRel);
    }

    pub fn clear(&self, bit: u64) {
        self.words[(bit / 64) as usize].fetch_and(!(1 << (bit % 64)), Ordering::AcqRel);
    }

    /// Whether every bit in `start..end` is set.
    pub fn all(&self, start: u64, end: u64) -> bool {
        (start..end).all(|bit| self.get(bit))
    }

    /// How many bits are set.
    pub fn count(&self) -> u64 {
        self.words
            .iter()
            .map(|w| w.load(Ordering::Acquire).count_ones() as u64)
            .sum()
    }

    pub fn byte_len(&self) -> usize {
        self.words.len() * 8
    }

    pub fn write_to(&self, out: &mut Vec<u8>) {
        for word in &self.words {
            out.extend_from_slice(&word.load(Ordering::Acquire).to_le_bytes());
        }
    }

    /// A bitmap of `bits` bits saved by [`Bitmap::write_to`].
    pub fn read_from(bytes: &[u8], bits: u64) -> Option<Self> {
        let words = bits.div_ceil(64) as usize;
        if bytes.len() != words * 8 {
            return None;
        }
        Some(Self {
            words: bytes
                .chunks_exact(8)
                .map(|w| AtomicU64::new(u64::from_le_bytes(w.try_into().unwrap())))
                .collect(),
        })
    }

    /// Indices of 64-bit words with any bit set: a fast scan for dirty blocks.
    pub fn nonzero_words(&self) -> impl Iterator<Item = u64> + '_ {
        self.words
            .iter()
            .enumerate()
            .filter(|(_, w)| w.load(Ordering::Acquire) != 0)
            .map(|(i, _)| i as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_clear_ranges() {
        let bitmap = Bitmap::new(200);
        assert!(!bitmap.all(0, 1));
        bitmap.set(3);
        bitmap.set(130);
        assert!(bitmap.get(3) && bitmap.get(130) && !bitmap.get(4));
        assert!(!bitmap.all(0, 10));
        (0..10).for_each(|b| bitmap.set(b));
        assert!(bitmap.all(0, 10));
        assert_eq!(bitmap.nonzero_words().collect::<Vec<_>>(), vec![0, 2]);
        assert_eq!(bitmap.count(), 11);
        let mut saved = Vec::new();
        bitmap.write_to(&mut saved);
        let restored = Bitmap::read_from(&saved, 200).unwrap();
        assert!(restored.get(130) && restored.get(9) && !restored.get(10));
        assert!(Bitmap::read_from(&saved[1..], 200).is_none());
        bitmap.clear(130);
        assert_eq!(bitmap.nonzero_words().collect::<Vec<_>>(), vec![0]);
    }
}
