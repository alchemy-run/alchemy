//! Heads served over HTTP: a coordinator (a Durable Object, say) holds each
//! head's record and moves it with compare-and-set, and blockd reaches it
//! with three requests:
//!
//! ```text
//! GET  <base>/<head>   → 200 Head | 404
//! POST <base>/<head>   {"expected": Head | null, "new": Head | null}
//!                      → 200 | 409 {"found": Head | null}
//! GET  <base>          → 200 [[name, Head], …]
//! ```

use super::{Head, MetaStore, check_head_name, conflict};
use crate::{Error, Result};
use async_trait::async_trait;

pub struct HttpMetaStore {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl HttpMetaStore {
    /// Heads under `base` (`http://host/heads`), with an optional bearer token.
    pub fn new(base: impl Into<String>, token: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base: base.into().trim_end_matches('/').to_string(),
            token,
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
    Error::Store(format!("heads: {e}"))
}

fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|e| store_error(format!("bad reply: {e}")))
}

#[derive(serde::Serialize)]
struct Cas<'a> {
    expected: Option<&'a Head>,
    new: Option<&'a Head>,
}

#[derive(serde::Deserialize)]
struct Found {
    found: Option<Head>,
}

#[async_trait]
impl MetaStore for HttpMetaStore {
    async fn get(&self, head: &str) -> Result<Option<Head>> {
        check_head_name(head)?;
        let response = self
            .request(reqwest::Method::GET, &format!("/{head}"))
            .send()
            .await
            .map_err(store_error)?;
        match response.status().as_u16() {
            404 => Ok(None),
            200 => decode(&response.bytes().await.map_err(store_error)?).map(Some),
            status => Err(store_error(format!("GET {head}: {status}"))),
        }
    }

    async fn cas(&self, head: &str, expected: Option<&Head>, new: Option<&Head>) -> Result<()> {
        check_head_name(head)?;
        let body = serde_json::to_vec(&Cas { expected, new }).expect("a request serializes");
        let response = self
            .request(reqwest::Method::POST, &format!("/{head}"))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(store_error)?;
        match response.status().as_u16() {
            200 => Ok(()),
            409 => {
                let found: Found = decode(&response.bytes().await.map_err(store_error)?)?;
                Err(conflict(head, expected, found.found.as_ref()))
            }
            status => Err(store_error(format!("POST {head}: {status}"))),
        }
    }

    async fn list(&self) -> Result<Vec<(String, Head)>> {
        let response = self
            .request(reqwest::Method::GET, "")
            .send()
            .await
            .map_err(store_error)?;
        if !response.status().is_success() {
            return Err(store_error(format!("GET: {}", response.status())));
        }
        decode(&response.bytes().await.map_err(store_error)?)
    }
}
