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

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn compress(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    zstd::bulk::compress(bytes, ZSTD_LEVEL)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn decompress(bytes: &[u8], size: usize) -> std::io::Result<Vec<u8>> {
    zstd::bulk::decompress(bytes, size)
}

// WebAssembly: the same zstd frames, from the pure-Rust ruzstd.
#[cfg(target_arch = "wasm32")]
pub(crate) fn compress(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let _ = ZSTD_LEVEL;
    Ok(ruzstd::encoding::compress_to_vec(
        bytes,
        ruzstd::encoding::CompressionLevel::Fastest,
    ))
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn decompress(bytes: &[u8], size: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut source = bytes;
    let mut decoder = ruzstd::decoding::StreamingDecoder::new(&mut source)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    let mut out = Vec::with_capacity(size);
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Packs written natively must open in WebAssembly (ruzstd) and back.
    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn zstd_and_ruzstd_read_each_other() {
        use std::io::Read;
        let extent: Vec<u8> = (0..EXTENT_SIZE).map(|i| (i * 7 % 13) as u8).collect();
        let native = compress(&extent).unwrap();
        let mut source = native.as_slice();
        let mut out = Vec::new();
        ruzstd::decoding::StreamingDecoder::new(&mut source)
            .unwrap()
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, extent, "ruzstd reads zstd");
        let pure = ruzstd::encoding::compress_to_vec(
            extent.as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        assert_eq!(
            decompress(&pure, EXTENT_SIZE as usize).unwrap(),
            extent,
            "zstd reads ruzstd"
        );
    }

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
