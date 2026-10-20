/// The unit the kernel reads and writes, and the unit of dirty tracking.
pub const BLOCK_SIZE: u64 = 4096;

/// The unit of storage: a run of blocks fetched, compressed and stored together.
pub const EXTENT_SIZE: u64 = 256 * 1024;

/// zstd level for extents: fast enough to keep up with flushes.
pub(crate) const ZSTD_LEVEL: i32 = 3;

/// Whether every byte is zero. Zero extents are never stored.
pub fn is_zero(bytes: &[u8]) -> bool {
    let (prefix, words, suffix) = unsafe { bytes.align_to::<u128>() };
    prefix.iter().all(|&b| b == 0)
        && words.iter().all(|&w| w == 0)
        && suffix.iter().all(|&b| b == 0)
}

pub(crate) fn compress(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::bulk::compress(bytes, ZSTD_LEVEL)
}

pub(crate) fn decompress(bytes: &[u8], size: usize) -> std::io::Result<Vec<u8>> {
    zstd::bulk::decompress(bytes, size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_detection() {
        assert!(is_zero(&vec![0u8; EXTENT_SIZE as usize]));
        let mut bytes = vec![0u8; 1000];
        bytes[999] = 1;
        assert!(!is_zero(&bytes));
        bytes[999] = 0;
        bytes[3] = 7;
        assert!(!is_zero(&bytes));
    }
}
