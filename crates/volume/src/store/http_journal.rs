//! Journal entries kept by the coordinator that holds the heads, which
//! appends and checks the lease in one step:
//!
//! ```text
//! POST   <base>/<head>/<epoch>/<seq>          body: the entry
//!        → 200 written | 208 already there | 409 fenced
//! GET    <base>/<head>/<epoch>/<seq>          → 200 the entry | 404
//! DELETE <base>/<head>/<epoch>?from=<a>&to=<b> → 200
//! ```

use super::journal::{Appended, JournalStore};
use crate::{Error, Result};
use async_trait::async_trait;
use std::ops::Range;

pub struct HttpJournalStore {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
    max_entry_blocks: usize,
}

impl HttpJournalStore {
    /// Entries under `base`, each at most `max_entry_blocks` blocks (what
    /// the coordinator can store as one value).
    pub fn new(base: impl Into<String>, token: Option<String>, max_entry_blocks: usize) -> Self {
        Self {
            client: reqwest::Client::new(),
            base: base.into().trim_end_matches('/').to_string(),
            token,
            max_entry_blocks: max_entry_blocks.max(1),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let builder = self.client.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }
}

fn store_error(e: impl std::fmt::Display) -> Error {
    Error::Store(format!("journal: {e}"))
}

#[async_trait]
impl JournalStore for HttpJournalStore {
    async fn append(&self, head: &str, epoch: u64, seq: u64, bytes: Vec<u8>) -> Result<Appended> {
        let response = self
            .request(reqwest::Method::POST, &format!("/{head}/{epoch}/{seq}"))
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(store_error)?;
        match response.status().as_u16() {
            200 => Ok(Appended::Written),
            208 => Ok(Appended::Already),
            409 => Ok(Appended::Fenced),
            status => Err(store_error(format!("POST {head}/{epoch}/{seq}: {status}"))),
        }
    }

    async fn get(&self, head: &str, epoch: u64, seq: u64) -> Result<Option<Vec<u8>>> {
        let response = self
            .request(reqwest::Method::GET, &format!("/{head}/{epoch}/{seq}"))
            .send()
            .await
            .map_err(store_error)?;
        match response.status().as_u16() {
            404 => Ok(None),
            200 => Ok(Some(response.bytes().await.map_err(store_error)?.to_vec())),
            status => Err(store_error(format!("GET {head}/{epoch}/{seq}: {status}"))),
        }
    }

    async fn delete(&self, head: &str, epoch: u64, seqs: Range<u64>) -> Result<()> {
        let response = self
            .request(
                reqwest::Method::DELETE,
                &format!("/{head}/{epoch}?from={}&to={}", seqs.start, seqs.end),
            )
            .send()
            .await
            .map_err(store_error)?;
        if !response.status().is_success() {
            return Err(store_error(format!(
                "DELETE {head}/{epoch}: {}",
                response.status()
            )));
        }
        Ok(())
    }

    fn max_entry_blocks(&self) -> usize {
        self.max_entry_blocks
    }
}
