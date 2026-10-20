use crate::Hash;

/// Everything a volume operation can fail with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An object the volume refers to is missing from the blob store.
    #[error("object {0} is missing")]
    Missing(String),
    /// Bytes read back don't hash to the id they were stored under.
    #[error("object {key} is corrupt: {reason}")]
    Corrupt { key: String, reason: String },
    /// A head moved since it was read: someone else committed first.
    #[error("head {head} moved: expected {expected:?}, found {found:?}")]
    Conflict {
        head: String,
        expected: Option<Hash>,
        found: Option<Hash>,
    },
    /// The head doesn't exist.
    #[error("head {0} does not exist")]
    NoHead(String),
    /// The head already exists.
    #[error("head {0} already exists")]
    HeadExists(String),
    /// A request is outside the volume or not aligned to its blocks.
    #[error("invalid request: {0}")]
    Invalid(String),
    /// The storage backend failed.
    #[error("store: {0}")]
    Store(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
