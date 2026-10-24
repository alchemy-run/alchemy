//! Heads over HTTP: a minimal server implementing the protocol over a
//! memory store, and leases running through it.
#![cfg(feature = "http")]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use volume::store::{
    Head, HttpJournalStore, HttpMetaStore, MemoryBlobStore, MemoryMetaStore, MetaStore,
};
use volume::{BLOCK_SIZE, Error, Volume};

/// Journal entries the way the coordinator keeps them: appended only if
/// the position is free and the epoch still holds the head.
type Entries = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// Serves `heads` at `http://127.0.0.1:<port>/heads`, and a journal at `/journal`.
async fn serve(heads: Arc<MemoryMetaStore>) -> String {
    let entries: Entries = Arc::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let heads = heads.clone();
            let entries = entries.clone();
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
                    if let Some(rest) = path.strip_prefix("/journal/") {
                        let (rest, query) = rest.split_once('?').unwrap_or((rest, ""));
                        let parts: Vec<&str> = rest.split('/').collect();
                        let (status, reply) = match (method.as_str(), parts.as_slice()) {
                            ("POST", [head, epoch, seq]) => {
                                let key = format!("{head}/{epoch}/{seq}");
                                let record = heads.get(head).await.unwrap();
                                let held = record.is_some_and(|r| {
                                    !r.deleted && r.epoch == epoch.parse::<u64>().unwrap()
                                });
                                let mut map = entries.lock().unwrap();
                                match map.get(&key) {
                                    Some(existing) if *existing == body => (208, Vec::new()),
                                    Some(_) => (409, Vec::new()),
                                    None if !held => (409, Vec::new()),
                                    None => {
                                        map.insert(key, body.clone());
                                        (200, Vec::new())
                                    }
                                }
                            }
                            ("GET", [head, epoch, seq]) => {
                                match entries
                                    .lock()
                                    .unwrap()
                                    .get(&format!("{head}/{epoch}/{seq}"))
                                {
                                    Some(bytes) => (200, bytes.clone()),
                                    None => (404, Vec::new()),
                                }
                            }
                            ("DELETE", [head, epoch]) => {
                                let range: HashMap<&str, u64> = query
                                    .split('&')
                                    .filter_map(|kv| kv.split_once('='))
                                    .map(|(k, v)| (k, v.parse().unwrap()))
                                    .collect();
                                let mut map = entries.lock().unwrap();
                                for seq in range["from"]..range["to"] {
                                    map.remove(&format!("{head}/{epoch}/{seq}"));
                                }
                                (200, Vec::new())
                            }
                            _ => (405, Vec::new()),
                        };
                        let head = format!(
                            "HTTP/1.1 {status} X\r\ncontent-length: {}\r\n\r\n",
                            reply.len()
                        );
                        write.write_all(head.as_bytes()).await.unwrap();
                        write.write_all(&reply).await.unwrap();
                        continue;
                    }
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

#[tokio::test]
async fn a_coordinator_journal_appends_and_fences_in_one_step() {
    let heads = Arc::new(MemoryMetaStore::new());
    let url = serve(heads.clone()).await;
    let base = url.trim_end_matches("/heads").to_string();
    let blobs = Arc::new(MemoryBlobStore::new());
    let volume = Volume::new(blobs.clone(), Arc::new(HttpMetaStore::new(url, None))).with_journal(
        Arc::new(HttpJournalStore::new(format!("{base}/journal"), None, 256)),
    );
    volume.create("main", 2 * 1024 * 1024).await.unwrap();
    let block = |byte: u8| vec![byte; BLOCK_SIZE as usize];

    let mut old = volume.acquire("main").await.unwrap();
    volume.append(&mut old, vec![(1, block(1))]).await.unwrap();
    assert!(
        blobs.keys().iter().all(|key| !key.starts_with("journal/")),
        "entries live in the coordinator, not the blob store"
    );
    drop(old.clone());
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
    assert_eq!(
        extent[BLOCK_SIZE as usize], 1,
        "the old lease's entry was folded"
    );
    assert_eq!(volume.journal().max_entry_blocks(), 256);
}
