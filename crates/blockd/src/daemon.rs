//! `blockd daemon`: one process per machine that owns every mounted head,
//! every forked call and every cache on it, driven over HTTP.
//!
//! ```text
//! GET  /v1/status                      the daemon's heads, calls and counters
//! POST /v1/heads                       mount a head
//! POST /v1/heads/<head>/<op>           sync | snapshot | checkpoint | apply | status | detach
//!                                      | exec (→ {"id"}, waited on as a call) | spawn | processes
//! POST /v1/calls                       start a command on a fork of a snapshot → {"id":…}
//! GET  /v1/calls/<id>?wait=<ms>        its result once done, else {"done":false} after <ms>
//! POST /v1/calls/<id>/<op>             a kept call's commit | status | detach | exec | spawn
//! POST /v1/store/<op>                  head | fork | reset | drop | history | blob-delete
//! GET  /v1/spawns/<id>?stream=out|err&offset=<n>   a spawned process's output, and exit code
//! POST /v1/spawns/<id>/kill            signal it
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

use crate::call::{self, Contained, Kept, Run, Spec};
use crate::container::{Container, Isolation, Runtime};
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
    /// A static blockd: the init of every container. Default: this binary.
    pub init: Option<PathBuf>,
}

pub struct Daemon {
    config: Config,
    runtime: Handle,
    started: Instant,
    stores: Mutex<HashMap<String, Arc<Volume>>>,
    caches: Arc<Mutex<HashSet<PathBuf>>>,
    heads: Mutex<HashMap<String, Arc<Mutex<Option<MountedHead>>>>>,
    calls: Mutex<HashMap<String, Arc<CallEntry>>>,
    /// Images mounted read-only, shared by every container that uses one.
    images: Mutex<HashMap<Hash, Arc<Image>>>,
    /// Background processes (`spawn`), until read to their end and reaped.
    spawns: Mutex<HashMap<String, Arc<Spawned>>>,
    counters: Mutex<Counters>,
}

/// A background process and its output files.
struct Spawned {
    child: Mutex<std::process::Child>,
    exit: Mutex<Option<i32>>,
    out: PathBuf,
    err: PathBuf,
}

/// An image snapshot, attached and mounted read-only.
struct Image {
    dir: PathBuf,
    _mount: Mutex<crate::mount::Mount>,
    _device: Arc<crate::Device>,
    _cache: CacheLease,
}

#[derive(Default, serde::Serialize)]
struct Counters {
    mounts: u64,
    calls: u64,
    execs: u64,
    images: u64,
    diffs: u64,
    applies: u64,
}

struct MountedHead {
    head: Head,
    /// Where its commands run, if not on this machine.
    container: Option<Arc<Container>>,
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
    /// Run the head's commands (`exec`) in a container.
    isolation: Option<IsolationRequest>,
}

/// How a request asks for isolation: a runtime, and an image by directory or
/// by snapshot (mounted read-only from the request's store).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IsolationRequest {
    runtime: Runtime,
    rootfs: Option<PathBuf>,
    image: Option<String>,
    path: String,
    #[serde(default = "yes")]
    host_network: bool,
    #[serde(default)]
    env: HashMap<String, String>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecRequest {
    command: String,
    cwd: Option<PathBuf>,
    #[serde(default)]
    env: HashMap<String, String>,
    timeout_ms: Option<u64>,
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
    isolation: Option<IsolationRequest>,
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
            images: Mutex::new(HashMap::new()),
            spawns: Mutex::new(HashMap::new()),
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
            ("POST", ["v1", "store", op]) => self.store_op(op, &request),
            ("GET", ["v1", "spawns", id]) => self.read_spawn(id, &request),
            ("POST", ["v1", "spawns", id, "kill"]) => self.kill_spawn(id, &request),
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

    fn init(&self) -> PathBuf {
        self.config
            .init
            .clone()
            .or_else(|| std::env::current_exe().ok())
            .unwrap_or_else(|| PathBuf::from("/usr/local/bin/blockd"))
    }

    /// An image snapshot mounted read-only, once per machine.
    fn image(&self, volume: &Arc<Volume>, snapshot: Hash, mode: Mode) -> Result<Arc<Image>> {
        let mut images = self.images.lock().unwrap();
        if let Some(image) = images.get(&snapshot) {
            return Ok(image.clone());
        }
        let cache = self.cache(None, &format!("image-{}.cache", &snapshot.to_hex()[..16]));
        let device = Arc::new(crate::Device::open_snapshot(
            volume.clone(),
            snapshot,
            cache.path(),
            self.runtime.clone(),
        )?);
        let dir = self.config.state.join(format!("image-{}", snapshot.to_hex()));
        let mount = crate::mount::mount_as(&device, mode, cache.path(), &dir, true)?;
        let image = Arc::new(Image {
            dir,
            _mount: Mutex::new(mount),
            _device: device,
            _cache: cache,
        });
        images.insert(snapshot, image.clone());
        self.counters.lock().unwrap().images += 1;
        Ok(image)
    }

    /// What a request's isolation means here: its image as a directory.
    fn isolation(&self, request: &IsolationRequest, volume: &Arc<Volume>, mode: Mode) -> Result<Isolation> {
        let rootfs = match (&request.rootfs, &request.image) {
            (Some(rootfs), _) => rootfs.clone(),
            (None, Some(image)) => {
                let snapshot = Hash::from_hex(image).context("`image` is not a snapshot id")?;
                self.image(volume, snapshot, mode)?.dir.clone()
            }
            (None, None) => bail!("isolation needs `rootfs` (a directory) or `image` (a snapshot)"),
        };
        let mut env: Vec<(String, String)> = request.env.clone().into_iter().collect();
        env.sort();
        Ok(Isolation {
            runtime: request.runtime,
            rootfs,
            path: request.path.clone(),
            host_network: request.host_network,
            env,
        })
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
            let isolation = request
                .isolation
                .as_ref()
                .map(|isolation| self.isolation(isolation, &volume, mode))
                .transpose()?;
            let (head, ready) = Head::mount(
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
            )?;
            let container = match &isolation {
                Some(isolation) => {
                    let id = format!("head-{}", sanitize(&request.head));
                    match Container::start(&id, isolation, &request.dir, &self.config.state, &self.init()) {
                        Ok(container) => Some(Arc::new(container)),
                        Err(e) => {
                            let _ = head.detach();
                            return Err(e);
                        }
                    }
                }
                None => None,
            };
            Ok((head, ready, container))
        });
        match mounted {
            Ok((head, ready, container)) => {
                *slot = Some(MountedHead { head, container, _cache: cache });
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
            "exec" => {
                let body: ExecRequest = serde_json::from_slice(&request.body).context("an exec's body")?;
                let container = mounted.container.clone();
                let dir = mounted.head.dir().to_path_buf();
                drop(slot);
                self.start_exec(container, dir, body)
            }
            "spawn" => {
                let body: ExecRequest = serde_json::from_slice(&request.body).context("a spawn's body")?;
                let container = mounted.container.clone();
                let dir = mounted.head.dir().to_path_buf();
                drop(slot);
                self.spawn(container, dir, body)
            }
            "processes" => Ok(json!({
                "processes": match &mounted.container {
                    Some(container) => container.processes(),
                    None => crate::mount::users(mounted.head.dir()),
                }
            })),
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
                if let Some(container) = &taken.container {
                    container.destroy()?;
                }
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
        let isolation = request
            .isolation
            .as_ref()
            .map(|isolation| timings.time("image", || self.isolation(isolation, &volume, mode)))
            .transpose()?;
        let init = self.init();
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
                contained: isolation.as_ref().map(|isolation| Contained {
                    isolation,
                    id: format!("call-{id}"),
                    state: &self.config.state,
                    init: &init,
                }),
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
        if op == "exec" || op == "spawn" {
            // A command on the kept fork, beside what's already running there.
            let (held, _, _) = &**kept.as_ref().unwrap();
            let container = held.container.clone();
            let dir = held.call.dir().to_path_buf();
            drop(state);
            let body: ExecRequest = serde_json::from_slice(&request.body).context("the command")?;
            return if op == "exec" {
                self.start_exec(container, dir, body)
            } else {
                self.spawn(container, dir, body)
            };
        }
        let body: Body = optional_body(request)?;
        match op {
            "status" => {
                let (held, _, _) = &**kept.as_ref().unwrap();
                Ok(json!({ "survivors": held.survivors() }))
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
                    "survivors": held.survivors(), "timings": timings,
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

    /// A command on a mounted head, in its container or on this machine,
    /// waited on like a call (`GET /v1/calls/<id>`).
    fn start_exec(
        &self,
        container: Option<Arc<Container>>,
        dir: PathBuf,
        request: ExecRequest,
    ) -> Result<Value> {
        let id = new_id();
        let entry = Arc::new(CallEntry {
            state: Mutex::new(CallState::Running),
            done: Condvar::new(),
        });
        self.calls.lock().unwrap().insert(id.clone(), entry.clone());
        self.counters.lock().unwrap().execs += 1;
        let out = self.config.run.join(format!("exec-{id}.out"));
        let err = self.config.run.join(format!("exec-{id}.err"));
        let run = Run {
            command: request.command,
            cwd: request.cwd,
            env: request.env.into_iter().collect(),
            timeout: request.timeout_ms.map(Duration::from_millis),
            stdout: Some(std::fs::File::create(&out)?),
            stderr: Some(std::fs::File::create(&err)?),
            clean_env: true,
        };
        std::thread::Builder::new()
            .name(format!("blockd-exec-{}", &id[..8]))
            .spawn(move || {
                let mut timings = Timings::new();
                let ran = timings.time("run", || match &container {
                    Some(container) => container.exec(&run),
                    None => run_on_host(&run, &dir),
                });
                let encode = |path: &Path| {
                    let bytes = std::fs::read(path).unwrap_or_default();
                    let _ = std::fs::remove_file(path);
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                };
                let (stdout, stderr) = (encode(&out), encode(&err));
                let result = match ran {
                    Ok((code, timed_out)) => json!({
                        "done": true, "exitCode": code, "timedOut": timed_out,
                        "stdout": stdout, "stderr": stderr, "timings": timings,
                    }),
                    Err(e) => json!({ "ok": false, "done": true, "error": format!("{e:#}") }),
                };
                *entry.state.lock().unwrap() = CallState::Done {
                    result,
                    kept: None,
                    at: Instant::now(),
                };
                entry.done.notify_all();
            })?;
        Ok(json!({ "id": id }))
    }

    /// Background processes: started, read by offset, killed.
    fn spawn(&self, container: Option<Arc<Container>>, dir: PathBuf, request: ExecRequest) -> Result<Value> {
        let id = new_id();
        let out = self.config.run.join(format!("spawn-{id}.out"));
        let err = self.config.run.join(format!("spawn-{id}.err"));
        let run = Run {
            command: request.command,
            cwd: request.cwd,
            env: request.env.into_iter().collect(),
            timeout: None,
            stdout: Some(std::fs::File::create(&out)?),
            stderr: Some(std::fs::File::create(&err)?),
            clean_env: true,
        };
        let mut command = match &container {
            Some(container) => container.command(&run)?,
            None => host_command(&run, &dir),
        };
        let child = command.spawn().context("starting the process")?;
        let pid = child.id();
        let spawned = Arc::new(Spawned {
            child: Mutex::new(child),
            exit: Mutex::new(None),
            out,
            err,
        });
        self.spawns.lock().unwrap().insert(id.clone(), spawned.clone());
        std::thread::Builder::new()
            .name(format!("blockd-spawn-{}", &id[..8]))
            .spawn(move || loop {
                let status = spawned.child.lock().unwrap().try_wait();
                match status {
                    Ok(Some(status)) => {
                        *spawned.exit.lock().unwrap() = Some(status.code().unwrap_or(128));
                        return;
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => {
                        *spawned.exit.lock().unwrap() = Some(128);
                        return;
                    }
                }
            })?;
        Ok(json!({ "id": id, "pid": pid }))
    }

    fn read_spawn(&self, id: &str, request: &Request) -> Result<Value> {
        use std::io::{Read, Seek};
        let spawned = self
            .spawns
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!(NotFound))
            .with_context(|| format!("no process {id} here"))?;
        let path = if request.param("stream") == Some("err") { &spawned.err } else { &spawned.out };
        let offset: u64 = request.param("offset").and_then(|n| n.parse().ok()).unwrap_or(0);
        // The exit code first: output written before the exit is all there.
        let exit = *spawned.exit.lock().unwrap();
        let mut file = std::fs::File::open(path)?;
        file.seek(std::io::SeekFrom::Start(offset))?;
        let mut data = Vec::new();
        file.take(1 << 20).read_to_end(&mut data)?;
        Ok(json!({
            "data": base64::engine::general_purpose::STANDARD.encode(&data),
            "exitCode": exit,
        }))
    }

    fn kill_spawn(&self, id: &str, request: &Request) -> Result<Value> {
        #[derive(Deserialize, Default)]
        struct Body {
            signal: Option<i32>,
        }
        let body: Body = optional_body(request)?;
        let spawned = self
            .spawns
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!(NotFound))
            .with_context(|| format!("no process {id} here"))?;
        let pid = spawned.child.lock().unwrap().id() as i32;
        // The runtime's exec forwards it to the process inside.
        unsafe { libc::kill(pid, body.signal.unwrap_or(libc::SIGTERM)) };
        Ok(json!({}))
    }

    /// The store's heads, as the service manages them.
    fn store_op(&self, op: &str, request: &Request) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Body {
            #[serde(flatten)]
            store: StoreSpec,
            head: Option<String>,
            from: Option<String>,
            at: Option<String>,
            to: Option<String>,
            limit: Option<usize>,
            key: Option<String>,
        }
        let body: Body = serde_json::from_slice(&request.body).context("the request's body")?;
        let volume = self.volume(&body.store)?;
        let required = |field: &Option<String>, name: &str| -> Result<String> {
            field.clone().with_context(|| format!("`{name}` is required"))
        };
        let block = |future: std::pin::Pin<Box<dyn std::future::Future<Output = volume::Result<Value>> + Send + '_>>| {
            self.runtime.block_on(future).map_err(anyhow::Error::from)
        };
        match op {
            "head" => {
                let head = required(&body.head, "head")?;
                match self.runtime.block_on(volume.head(&head)) {
                    Ok(snapshot) => Ok(json!({ "snapshot": snapshot })),
                    Err(volume::Error::NoHead(_)) => Ok(json!({ "snapshot": null })),
                    Err(e) => Err(e.into()),
                }
            }
            "fork" => {
                let to = required(&body.to, "to")?;
                block(Box::pin(async {
                    let snapshot = match (&body.from, &body.at) {
                        (Some(from), _) => volume.fork(from, &to).await?,
                        (None, Some(at)) => {
                            let at = Hash::from_hex(at)
                                .ok_or_else(|| volume::Error::Invalid("`at` is not a snapshot id".into()))?;
                            volume.fork_at(at, &to).await?;
                            at
                        }
                        (None, None) => return Err(volume::Error::Invalid("`from` or `at` is required".into())),
                    };
                    Ok(json!({ "snapshot": snapshot }))
                }))
            }
            "reset" => {
                let head = required(&body.head, "head")?;
                let to = Hash::from_hex(&required(&body.to, "to")?).context("`to` is not a snapshot id")?;
                block(Box::pin(async {
                    volume.reset(&head, to).await?;
                    Ok(json!({}))
                }))
            }
            "drop" => {
                let head = required(&body.head, "head")?;
                match self.runtime.block_on(volume.drop_head(&head)) {
                    Ok(()) | Err(volume::Error::NoHead(_)) => Ok(json!({})),
                    Err(e) => Err(e.into()),
                }
            }
            "history" => {
                let head = required(&body.head, "head")?;
                block(Box::pin(async {
                    let snapshot = volume.head(&head).await?;
                    let history = volume.history(&snapshot, body.limit.unwrap_or(20)).await?;
                    Ok(json!({ "history": history }))
                }))
            }
            "blob-delete" => {
                let key = required(&body.key, "key")?;
                self.runtime.block_on(volume.blobs().delete(&key))?;
                Ok(json!({}))
            }
            other => Err(anyhow!(NotFound)).context(format!("no store operation {other:?}")),
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

/// A name as a container id allows it.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// A command on this machine, in `dir`, with `AWS_*` and `BLOCKD_*` left out
/// of its environment.
fn host_command(run: &Run, dir: &Path) -> std::process::Command {
    use std::os::unix::process::CommandExt;
    let mut child = std::process::Command::new("sh");
    child
        .args(["-c", &run.command])
        .current_dir(run.cwd.as_deref().unwrap_or(dir))
        .process_group(0)
        .env_clear()
        .envs(std::env::vars().filter(|(name, _)| !name.starts_with("AWS_") && !name.starts_with("BLOCKD_")))
        .envs(run.env.iter().map(|(k, v)| (k, v)))
        .stdin(std::process::Stdio::null());
    if let Some(stdout) = run.stdout.as_ref().and_then(|f| f.try_clone().ok()) {
        child.stdout(stdout);
    }
    if let Some(stderr) = run.stderr.as_ref().and_then(|f| f.try_clone().ok()) {
        child.stderr(stderr);
    }
    child
}

/// A head's command on this machine, in the head's directory.
fn run_on_host(run: &Run, dir: &Path) -> Result<(i32, bool)> {
    let mut child = host_command(run, dir).spawn().context("starting the command")?;
    let pid = child.id() as i32;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok((status.code().unwrap_or(128), false));
        }
        if run.timeout.is_some_and(|t| started.elapsed() >= t) {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            let _ = child.wait();
            return Ok((124, true));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
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
