//! `blockd daemon`: one process per machine that owns every mounted head,
//! every forked call and every cache on it, driven over HTTP.
//!
//! ```text
//! GET  /v1/status                      the daemon's heads, calls and counters
//! POST /v1/heads                       mount a head
//! POST /v1/heads/<head>/<op>           sync | snapshot | checkpoint | apply | status | detach
//! POST /v1/calls                       start a command on a fork of a snapshot → {"id":…}
//! GET  /v1/calls/<id>?wait=<ms>        its result once done, else {"done":false} after <ms>
//! POST /v1/calls/<id>/<op>             a kept call's commit | status | detach
//! POST /v1/diffs                       a patch from one snapshot to another
//! ```
//!
//! What it keeps between requests is what makes it fast: open stores (their
//! connections, and their caches of manifests and pages), cache files left
//! reusable by the last attach, and the mounts themselves. Every reply that
//! does work carries `timings`, milliseconds per phase.
//!
//! Every request needs `authorization: Bearer <token>` when the daemon has a
//! token (`BLOCKD_DAEMON_TOKEN`). A command run by a call gets the daemon's
//! environment without `AWS_*` and `BLOCKD_*`.

use crate::call::{self, Kept, Run, Spec};
use crate::head::{Head, HeadOptions};
use crate::http::{Request, Response};
use crate::mount::Mode;
use crate::timings::Timings;
use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Handle;
use volume::{Hash, Volume};

pub struct Config {
    pub token: Option<String>,
    /// Cache files, call workspaces and patches in progress.
    pub state: PathBuf,
    /// Commands' output while they run.
    pub run: PathBuf,
}

pub struct Daemon {
    config: Config,
    runtime: Handle,
    started: Instant,
    stores: Mutex<HashMap<String, Arc<Volume>>>,
    caches: Arc<Mutex<HashSet<PathBuf>>>,
    heads: Mutex<HashMap<String, Arc<Mutex<Option<MountedHead>>>>>,
    calls: Mutex<HashMap<String, Arc<CallEntry>>>,
    counters: Mutex<Counters>,
}

#[derive(Default, serde::Serialize)]
struct Counters {
    mounts: u64,
    calls: u64,
    diffs: u64,
    applies: u64,
}

struct MountedHead {
    head: Head,
    _cache: CacheLease,
}

struct CallEntry {
    state: Mutex<CallState>,
    done: Condvar,
}

enum CallState {
    Running,
    Done {
        result: Value,
        kept: Option<Box<(Kept, Arc<Volume>, CacheLease)>>,
        at: Instant,
    },
}

/// Fields every request that reaches a store carries.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoreSpec {
    store: String,
    heads: Option<String>,
    journal: Option<String>,
    heads_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MountRequest {
    #[serde(flatten)]
    store: StoreSpec,
    head: String,
    dir: PathBuf,
    cache: Option<PathBuf>,
    mode: Option<String>,
    flush_every: Option<u64>,
    #[serde(default)]
    prefetch: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallRequest {
    #[serde(flatten)]
    store: StoreSpec,
    snapshot: String,
    dir: PathBuf,
    command: String,
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: HashMap<String, String>,
    timeout_ms: Option<u64>,
    patch: Option<String>,
    #[serde(default)]
    keep: bool,
    mode: Option<String>,
    cache: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffRequest {
    #[serde(flatten)]
    store: StoreSpec,
    from: String,
    to: String,
    patch: Option<String>,
    mode: Option<String>,
}

/// Finished calls are kept this long for a caller that missed the result.
const KEEP_RESULTS: Duration = Duration::from_secs(600);
/// The longest a wait for a call holds a request open.
const MAX_WAIT: Duration = Duration::from_secs(60);

impl Daemon {
    pub fn new(config: Config, runtime: Handle) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&config.state)?;
        std::fs::create_dir_all(&config.run)?;
        Ok(Arc::new(Self {
            config,
            runtime,
            started: Instant::now(),
            stores: Mutex::new(HashMap::new()),
            caches: Arc::new(Mutex::new(HashSet::new())),
            heads: Mutex::new(HashMap::new()),
            calls: Mutex::new(HashMap::new()),
            counters: Mutex::new(Counters::default()),
        }))
    }

    /// Answers one request.
    pub fn handle(self: &Arc<Self>, request: Request) -> Response {
        if let Some(token) = &self.config.token {
            let given = request
                .header("authorization")
                .and_then(|value| value.strip_prefix("Bearer "))
                .unwrap_or("");
            if !same(given.as_bytes(), token.as_bytes()) {
                return Response::error(401, "a bad or missing token");
            }
        }
        let segments: Vec<&str> = request.path.trim_matches('/').split('/').collect();
        let routed = match (request.method.as_str(), segments.as_slice()) {
            ("GET", ["v1", "status"]) => Ok(self.status()),
            ("POST", ["v1", "heads"]) => body(&request).and_then(|r| self.mount(r)),
            ("POST", ["v1", "heads", head, op]) => self.head_op(&decode(head), op, &request),
            ("POST", ["v1", "calls"]) => body(&request).and_then(|r| self.start_call(r)),
            ("GET", ["v1", "calls", id]) => {
                let wait = request
                    .param("wait")
                    .and_then(|ms| ms.parse().ok())
                    .map(Duration::from_millis)
                    .unwrap_or(Duration::ZERO)
                    .min(MAX_WAIT);
                self.wait_call(id, wait)
            }
            ("POST", ["v1", "calls", id, op]) => self.call_op(id, op, &request),
            ("POST", ["v1", "diffs"]) => body(&request).and_then(|r| self.diff(r)),
            _ => return Response::error(404, format!("no route {} {}", request.method, request.path)),
        };
        match routed {
            Ok(mut value) => {
                if let Some(object) = value.as_object_mut() {
                    object.entry("ok").or_insert(Value::Bool(true));
                }
                Response::ok(value)
            }
            Err(e) => {
                let status = if e.downcast_ref::<NotFound>().is_some() {
                    404
                } else if e.downcast_ref::<Busy>().is_some() {
                    409
                } else {
                    500
                };
                Response::error(status, format!("{e:#}"))
            }
        }
    }

    fn status(&self) -> Value {
        let heads: Vec<Value> = self
            .heads
            .lock()
            .unwrap()
            .values()
            .filter_map(|entry| {
                let entry = entry.try_lock().ok()?;
                let mounted = entry.as_ref()?;
                Some(json!({
                    "head": mounted.head.name(),
                    "dir": mounted.head.dir(),
                    "status": mounted.head.device().status(),
                }))
            })
            .collect();
        let calls: Vec<Value> = self
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(id, entry)| {
                let state = match &*entry.state.lock().unwrap() {
                    CallState::Running => "running",
                    CallState::Done { kept: Some(_), .. } => "kept",
                    CallState::Done { .. } => "done",
                };
                json!({ "id": id, "state": state })
            })
            .collect();
        json!({
            "uptimeMs": self.started.elapsed().as_millis() as u64,
            "stores": self.stores.lock().unwrap().len(),
            "caches": self.caches.lock().unwrap().iter().collect::<Vec<_>>(),
            "heads": heads,
            "calls": calls,
            "counters": *self.counters.lock().unwrap(),
        })
    }

    /// The store `spec` names, opened once and kept.
    fn volume(&self, spec: &StoreSpec) -> Result<Arc<Volume>> {
        let key = format!(
            "{}\n{}\n{}\n{}",
            spec.store,
            spec.heads.as_deref().unwrap_or(""),
            spec.journal.as_deref().unwrap_or(""),
            spec.heads_token.as_deref().unwrap_or("")
        );
        let mut stores = self.stores.lock().unwrap();
        if let Some(volume) = stores.get(&key) {
            return Ok(volume.clone());
        }
        let volume = Arc::new(crate::store::open_with(
            &spec.store,
            spec.heads.as_deref(),
            spec.journal.as_deref(),
            spec.heads_token.clone(),
        )?);
        stores.insert(key, volume.clone());
        Ok(volume)
    }

    fn cache(&self, preferred: Option<&Path>, fallback: &str) -> CacheLease {
        let preferred = preferred
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.config.state.join(fallback));
        CacheLease::acquire(&self.caches, &preferred)
    }

    //#region heads

    fn mount(&self, request: MountRequest) -> Result<Value> {
        let volume = self.volume(&request.store)?;
        let entry = Arc::new(Mutex::new(None));
        let mut slot = entry.lock().unwrap();
        {
            let mut heads = self.heads.lock().unwrap();
            if heads.contains_key(&request.head) {
                return Err(anyhow!(Busy)).context(format!("{} is already mounted here", request.head));
            }
            heads.insert(request.head.clone(), entry.clone());
        }
        let cache = self.cache(request.cache.as_deref(), &format!("{}.cache", request.head));
        let mounted = mode(request.mode.as_deref()).and_then(|mode| {
            Head::mount(
                volume,
                &request.head,
                HeadOptions {
                    mode,
                    cache: cache.path(),
                    dir: &request.dir,
                    flush_every: request.flush_every.unwrap_or(5),
                    prefetch: request.prefetch,
                },
                self.runtime.clone(),
            )
        });
        match mounted {
            Ok((head, ready)) => {
                *slot = Some(MountedHead { head, _cache: cache });
                self.counters.lock().unwrap().mounts += 1;
                Ok(serde_json::to_value(ready)?)
            }
            Err(e) => {
                drop(slot);
                self.heads.lock().unwrap().remove(&request.head);
                Err(e)
            }
        }
    }

    fn head_op(&self, head: &str, op: &str, request: &Request) -> Result<Value> {
        let entry = self
            .heads
            .lock()
            .unwrap()
            .get(head)
            .cloned()
            .ok_or_else(|| anyhow!(NotFound))
            .with_context(|| format!("{head} isn't mounted here"))?;
        let mut slot = entry.lock().unwrap();
        let Some(mounted) = slot.as_mut() else {
            return Err(anyhow!(NotFound)).context(format!("{head} isn't mounted here"));
        };
        let device = mounted.head.device().clone();
        match op {
            "status" => Ok(json!({ "status": device.status() })),
            "sync" => {
                let mut timings = Timings::new();
                timings.time("sync", || device.sync())?;
                Ok(json!({ "timings": timings }))
            }
            "snapshot" => {
                #[derive(Deserialize, Default)]
                struct Body {
                    freeze: Option<String>,
                }
                let body: Body = optional_body(request)?;
                let mut timings = Timings::new();
                let snapshot = timings.time("snapshot", || {
                    crate::control::frozen(body.freeze.as_deref(), || device.snapshot())
                })?;
                Ok(json!({ "snapshot": snapshot, "timings": timings }))
            }
            "checkpoint" => {
                let mut timings = Timings::new();
                let paths = timings.time("checkpoint", || mounted.head.checkpoint())?;
                Ok(json!({ "paths": paths, "timings": timings }))
            }
            "apply" => {
                #[derive(Deserialize)]
                struct Body {
                    patches: Vec<String>,
                }
                let body: Body = serde_json::from_slice(&request.body).context("an apply's body")?;
                self.counters.lock().unwrap().applies += 1;
                mounted.head.apply(&body.patches)
            }
            "detach" => {
                let taken = slot.take().unwrap();
                drop(slot);
                self.heads.lock().unwrap().remove(head);
                let (snapshot, paths, timings) = taken.head.detach()?;
                Ok(json!({ "snapshot": snapshot, "paths": paths, "timings": timings }))
            }
            other => Err(anyhow!(NotFound)).context(format!("no head operation {other:?}")),
        }
    }

    //#endregion

    //#region calls

    fn start_call(self: &Arc<Self>, request: CallRequest) -> Result<Value> {
        let snapshot =
            Hash::from_hex(&request.snapshot).context("`snapshot` is not a snapshot id")?;
        let volume = self.volume(&request.store)?;
        let mode = mode(request.mode.as_deref())?;
        let id = new_id();
        let entry = Arc::new(CallEntry {
            state: Mutex::new(CallState::Running),
            done: Condvar::new(),
        });
        {
            let mut calls = self.calls.lock().unwrap();
            calls.retain(|_, entry| {
                !matches!(
                    &*entry.state.lock().unwrap(),
                    CallState::Done { kept: None, at, .. } if at.elapsed() > KEEP_RESULTS
                )
            });
            calls.insert(id.clone(), entry.clone());
        }
        self.counters.lock().unwrap().calls += 1;
        let daemon = self.clone();
        let call_id = id.clone();
        std::thread::Builder::new()
            .name(format!("blockd-call-{}", &id[..8]))
            .spawn(move || {
                let (result, kept) = match daemon.run_call(&call_id, snapshot, volume.clone(), mode, request) {
                    Ok((result, kept)) => (result, kept.map(|(kept, cache)| Box::new((kept, volume, cache)))),
                    Err(e) => (json!({ "ok": false, "error": format!("{e:#}") }), None),
                };
                *entry.state.lock().unwrap() = CallState::Done {
                    result,
                    kept,
                    at: Instant::now(),
                };
                entry.done.notify_all();
            })?;
        Ok(json!({ "id": id }))
    }

    fn run_call(
        &self,
        id: &str,
        snapshot: Hash,
        volume: Arc<Volume>,
        mode: Mode,
        request: CallRequest,
    ) -> Result<(Value, Option<(Kept, CacheLease)>)> {
        let mut timings = Timings::new();
        let cache = timings.time("cache", || self.cache(request.cache.as_deref(), "calls.cache"));
        let work = self.config.state.join(format!("call-{id}"));
        let out = self.config.run.join(format!("call-{id}.out"));
        let err = self.config.run.join(format!("call-{id}.err"));
        let run = Run {
            command: request.command,
            cwd: request.cwd,
            env: request.env.into_iter().collect(),
            timeout: request.timeout_ms.map(Duration::from_millis),
            stdout: Some(std::fs::File::create(&out)?),
            stderr: Some(std::fs::File::create(&err)?),
            clean_env: true,
        };
        let called = call::call(
            &volume,
            snapshot,
            Spec {
                mode,
                cache: cache.path(),
                dir: &request.dir,
                work: &work,
                run,
                patch: request.patch,
                keep: request.keep,
            },
            &self.runtime,
        );
        let encode = |path: &Path| {
            let bytes = std::fs::read(path).unwrap_or_default();
            let _ = std::fs::remove_file(path);
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };
        let (stdout, stderr) = (encode(&out), encode(&err));
        let (mut report, kept) = called?;
        timings.extend(&report.timings);
        report.timings = timings;
        let mut result = serde_json::to_value(&report)?;
        let object = result.as_object_mut().unwrap();
        object.insert("done".into(), Value::Bool(true));
        object.insert("stdout".into(), Value::String(stdout));
        object.insert("stderr".into(), Value::String(stderr));
        Ok((result, kept.map(|kept| (kept, cache))))
    }

    fn call_entry(&self, id: &str) -> Result<Arc<CallEntry>> {
        self.calls
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!(NotFound))
            .with_context(|| format!("no call {id} here"))
    }

    fn wait_call(&self, id: &str, wait: Duration) -> Result<Value> {
        let entry = self.call_entry(id)?;
        let state = entry.state.lock().unwrap();
        let (state, _) = entry
            .done
            .wait_timeout_while(state, wait, |state| matches!(state, CallState::Running))
            .unwrap();
        match &*state {
            CallState::Running => Ok(json!({ "done": false })),
            CallState::Done { result, .. } => {
                let mut result = result.clone();
                if let Some(object) = result.as_object_mut() {
                    object.insert("done".into(), Value::Bool(true));
                }
                Ok(result)
            }
        }
    }

    fn call_op(&self, id: &str, op: &str, request: &Request) -> Result<Value> {
        #[derive(Deserialize, Default)]
        struct Body {
            patch: Option<String>,
            #[serde(default)]
            full: bool,
        }
        let entry = self.call_entry(id)?;
        let mut state = entry.state.lock().unwrap();
        let CallState::Done { kept: kept @ Some(_), .. } = &mut *state else {
            return Err(anyhow!(NotFound)).context(format!("call {id} keeps nothing running"));
        };
        let body: Body = optional_body(request)?;
        match op {
            "status" => {
                let (held, _, _) = &**kept.as_ref().unwrap();
                Ok(json!({ "survivors": held.call.survivors() }))
            }
            "commit" => {
                let (held, volume, _) = &mut **kept.as_mut().unwrap();
                let mut timings = Timings::new();
                let (summary, patch) = call::commit_to_store(
                    &mut held.call,
                    body.patch.as_deref(),
                    volume,
                    &self.runtime,
                    body.full,
                    &mut timings,
                )?;
                Ok(json!({
                    "patch": patch, "summary": summary,
                    "survivors": held.call.survivors(), "timings": timings,
                }))
            }
            "detach" => {
                let (held, volume, _cache) = *kept.take().unwrap();
                drop(state);
                self.calls.lock().unwrap().remove(id);
                let (summary, patch, stopped, timings) =
                    held.detach(body.patch.as_deref(), &volume, &self.runtime)?;
                Ok(json!({
                    "patch": patch, "summary": summary, "survivors": stopped, "timings": timings,
                }))
            }
            other => Err(anyhow!(NotFound)).context(format!("no call operation {other:?}")),
        }
    }

    //#endregion

    fn diff(&self, request: DiffRequest) -> Result<Value> {
        let from = Hash::from_hex(&request.from).context("`from` is not a snapshot id")?;
        let to = Hash::from_hex(&request.to).context("`to` is not a snapshot id")?;
        let volume = self.volume(&request.store)?;
        let mode = mode(request.mode.as_deref())?;
        let (a, b) = (self.cache(None, "diff-from.cache"), self.cache(None, "diff-to.cache"));
        let work = self.config.state.join(format!("diff-{}", new_id()));
        self.counters.lock().unwrap().diffs += 1;
        let made = crate::call::diff(
            &volume,
            from,
            to,
            mode,
            (a.path(), b.path()),
            &work,
            request.patch.as_deref(),
            None,
            &self.runtime,
        );
        let _ = std::fs::remove_dir_all(&work);
        made
    }
}

/// A cache file in use by one attach; others are handed another.
pub struct CacheLease {
    path: PathBuf,
    held: Arc<Mutex<HashSet<PathBuf>>>,
}

impl CacheLease {
    fn acquire(held: &Arc<Mutex<HashSet<PathBuf>>>, preferred: &Path) -> Self {
        let mut taken = held.lock().unwrap();
        let stem = preferred.with_extension("");
        let path = (0..)
            .map(|n| {
                if n == 0 {
                    preferred.to_path_buf()
                } else {
                    PathBuf::from(format!("{}-{n}.cache", stem.display()))
                }
            })
            .find(|path| !taken.contains(path))
            .unwrap();
        taken.insert(path.clone());
        Self {
            path,
            held: held.clone(),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for CacheLease {
    fn drop(&mut self) {
        self.held.lock().unwrap().remove(&self.path);
    }
}

#[derive(Debug)]
struct NotFound;
impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("not found")
    }
}
impl std::error::Error for NotFound {}

#[derive(Debug)]
struct Busy;
impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("busy")
    }
}
impl std::error::Error for Busy {}

fn body<T: serde::de::DeserializeOwned>(request: &Request) -> Result<T> {
    serde_json::from_slice(&request.body).context("the request's body")
}

fn optional_body<T: serde::de::DeserializeOwned + Default>(request: &Request) -> Result<T> {
    if request.body.iter().all(u8::is_ascii_whitespace) {
        return Ok(T::default());
    }
    body(request)
}

fn mode(mode: Option<&str>) -> Result<Mode> {
    match mode.unwrap_or("auto") {
        "auto" => Mode::detect(),
        other => other.parse(),
    }
}

fn decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&segment[i + 1..i + 3], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = file.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Serves the daemon on `listen` (`host:port`) and `socket` (a Unix socket
/// path), writing `pidfile` once both are bound. Never returns.
pub fn serve(daemon: Arc<Daemon>, listen: Option<&str>, socket: Option<&Path>, pidfile: Option<&Path>) -> Result<()> {
    if listen.is_none() && socket.is_none() {
        bail!("the daemon needs --listen <host:port> or --socket <path>");
    }
    let handle: Arc<dyn Fn(Request) -> Response + Send + Sync> = {
        let daemon = daemon.clone();
        Arc::new(move |request| daemon.handle(request))
    };
    let mut threads = Vec::new();
    if let Some(socket) = socket {
        let _ = std::fs::remove_file(socket);
        let listener = std::os::unix::net::UnixListener::bind(socket)
            .with_context(|| format!("binding {}", socket.display()))?;
        let handle = handle.clone();
        threads.push(std::thread::spawn(move || crate::http::serve(listener.incoming(), handle)));
    }
    if let Some(listen) = listen {
        let listener =
            std::net::TcpListener::bind(listen).with_context(|| format!("binding {listen}"))?;
        let handle = handle.clone();
        threads.push(std::thread::spawn(move || crate::http::serve(listener.incoming(), handle)));
    }
    if let Some(pidfile) = pidfile {
        let tmp = pidfile.with_extension("tmp");
        std::fs::write(&tmp, format!("{}\n", std::process::id()))?;
        std::fs::rename(&tmp, pidfile)?;
    }
    tracing::info!("blockd daemon listening on {listen:?} {socket:?}");
    for thread in threads {
        let _ = thread.join();
    }
    Ok(())
}
