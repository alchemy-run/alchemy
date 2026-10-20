//! Heads over HTTP: a minimal server implementing the protocol over a
//! memory store, and leases running through it.
#![cfg(feature = "http")]

use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use volume::store::{Head, HttpMetaStore, MemoryBlobStore, MemoryMetaStore, MetaStore};
use volume::{BLOCK_SIZE, Error, Volume};

/// Serves `heads` at `http://127.0.0.1:<port>/heads`.
async fn serve(heads: Arc<MemoryMetaStore>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let heads = heads.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let mut parts = line.split_whitespace();
                    let (method, path) = (
                        parts.next().unwrap().to_string(),
                        parts.next().unwrap().to_string(),
                    );
                    let mut length = 0;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).await.unwrap();
                        if header.trim().is_empty() {
                            break;
                        }
                        if let Some(value) =
                            header.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            length = value.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).await.unwrap();
                    let name = path.trim_start_matches("/heads").trim_start_matches('/');
                    let (status, reply) = match (method.as_str(), name) {
                        ("GET", "") => (
                            200,
                            serde_json::to_vec(&heads.list().await.unwrap()).unwrap(),
                        ),
                        ("GET", name) => match heads.get(name).await.unwrap() {
                            Some(head) => (200, serde_json::to_vec(&head).unwrap()),
                            None => (404, b"{}".to_vec()),
                        },
                        ("POST", name) => {
                            #[derive(serde::Deserialize)]
                            struct Cas {
                                expected: Option<Head>,
                                new: Option<Head>,
                            }
                            let cas: Cas = serde_json::from_slice(&body).unwrap();
                            match heads
                                .cas(name, cas.expected.as_ref(), cas.new.as_ref())
                                .await
                            {
                                Ok(()) => (200, b"{}".to_vec()),
                                Err(Error::Conflict { .. }) => {
                                    let found = heads.get(name).await.unwrap();
                                    (
                                        409,
                                        serde_json::to_vec(&serde_json::json!({ "found": found }))
                                            .unwrap(),
                                    )
                                }
                                Err(e) => (500, e.to_string().into_bytes()),
                            }
                        }
                        _ => (405, Vec::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\n\r\n",
                        reply.len()
                    );
                    write.write_all(head.as_bytes()).await.unwrap();
                    write.write_all(&reply).await.unwrap();
                }
            });
        }
    });
    format!("http://{address}/heads")
}

#[tokio::test]
async fn leases_fence_through_http_heads() {
    let heads = Arc::new(MemoryMetaStore::new());
    let url = serve(heads.clone()).await;
    let volume = Volume::new(
        Arc::new(MemoryBlobStore::new()),
        Arc::new(HttpMetaStore::new(url, None)),
    );
    volume.create("main", 2 * 1024 * 1024).await.unwrap();
    let block = |byte: u8| vec![byte; BLOCK_SIZE as usize];

    let mut old = volume.acquire("main").await.unwrap();
    volume.append(&mut old, vec![(1, block(1))]).await.unwrap();
    let new = volume.acquire("main").await.unwrap();
    assert!(matches!(
        volume.append(&mut old, vec![(2, block(2))]).await,
        Err(Error::Fenced(_))
    ));
    let extent = volume
        .read_extent(&new.snapshot(), 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(extent[BLOCK_SIZE as usize], 1);
    assert_eq!(heads.get("main").await.unwrap().unwrap().epoch, new.epoch());
    assert_eq!(volume.heads().await.unwrap().len(), 1);
    assert!(volume.record("missing").await.is_err());
}
