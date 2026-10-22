import { createHash } from "node:crypto";
/**
 * The program every host of an `AWS.Workspace` runs: the workspace service
 * (`@alchemy.run/sandbox/WorkspaceService`'s API) over the blockd daemon on
 * the same machine. Sessions live here while they're active: a session's
 * head stays mounted, its commit log is here, and its commands run here, in
 * containers (runc or gVisor) on the workspace's image.
 *
 * NOT exported from `index.ts`.
 */
import type { WorkspaceExecResult } from "@alchemy.run/sandbox/Workspace";
import { WorkspaceError, type WorkspaceChanges } from "@alchemy.run/sandbox/Workspace";
import { conflicts } from "@alchemy.run/sandbox/WorkspaceMerge";
import type { ServiceExecBody } from "@alchemy.run/sandbox/WorkspaceService";
import { ServerHost } from "alchemy/Runtime/Process";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerRequestModule from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ChildProcess } from "effect/process";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/** What a host is configured with: bound into its environment at deploy. */
export interface HostConfig {
  readonly id: string;
  /** blockd's store: `s3://<bucket>/<prefix>`. */
  readonly store: string;
  readonly bucket: string;
  /** The head every new session forks from. */
  readonly base: string;
  /** The image commands run on: a snapshot in the store. */
  readonly image?: string;
  /** Where the workspace appears to commands. */
  readonly path: string;
  readonly isolation: "container" | "gvisor" | "none";
  readonly placement: "pinned" | "serverless" | "automatic";
  readonly lww: ReadonlyArray<string>;
  /** How long an unused session stays mounted. */
  readonly idleMs: number;
  /** Where blockd's binaries are in the bucket. */
  readonly binaries: string;
  /** The port the service listens on. */
  readonly port: number;
}

export const HOST_CONFIG = "ALCHEMY_WORKSPACE_HOST";
export const HOST_TOKEN = "ALCHEMY_WORKSPACE_TOKEN";

const DAEMON = "http://127.0.0.1:7681";
const HEADS = "/srv/alchemy/heads";
const CALLS = "/srv/alchemy/calls";
const WAIT_MS = 25_000;
/** Kept calls commit what changed this often. */
const HOST_SYNC = Duration.seconds(5);
/** Finished jobs are kept this long for a caller that missed the result. */
const KEEP_JOBS = Duration.toMillis(Duration.minutes(10));
/** An open that isn't renewed for this long is released. */
const OPEN_TTL = Duration.toMillis(Duration.minutes(2));

const fail = (message: string, cause?: unknown) => new WorkspaceError({ message, cause });

const validSession = (name: string) => /^[A-Za-z0-9._-]{1,200}$/.test(name);

/** The blockd daemon on this machine. */
const daemonClient = (token: string) => {
  const send = <A>(request: HttpClientRequest.HttpClientRequest, path: string) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(HttpClientRequest.bearerToken(request, token))
        .pipe(Effect.mapError((cause) => fail(`blockd ${path}: ${cause.message}`, cause)));
      const text = yield* response.text.pipe(
        Effect.mapError((cause) => fail(`blockd ${path}: ${cause.message}`, cause)),
      );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as { readonly ok?: boolean; readonly error?: string },
        catch: (cause) =>
          fail(`blockd ${path} answered ${response.status}: ${text.slice(0, 300)}`, cause),
      });
      if (response.status !== 200 || parsed.ok === false) {
        return yield* fail(`blockd ${path}: ${parsed.error ?? `status ${response.status}`}`);
      }
      return parsed as A;
    }).pipe(Effect.provide(FetchHttpClient.layer));
  const post = <A>(path: string, body: unknown = {}) =>
    send<A>(
      HttpClientRequest.post(`${DAEMON}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      path,
    );
  const get = <A>(path: string) => send<A>(HttpClientRequest.get(`${DAEMON}${path}`), path);
  /** A daemon job (a call, a head's exec), waited on in pieces. */
  const wait = <A extends { readonly done?: boolean }>(id: string) =>
    get<A>(`/v1/calls/${id}?wait=${WAIT_MS}`).pipe(
      Effect.repeat({ until: (reply) => reply.done === true }),
    );
  return { post, get, wait };
};

type Daemon = ReturnType<typeof daemonClient>;

interface PatchSummary {
  readonly paths: ReadonlyArray<string>;
  readonly bytes: number;
  readonly operations: number;
}

interface CallReply {
  readonly done: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly patch: string | null;
  readonly summary: PatchSummary;
  readonly survivors: ReadonlyArray<{ readonly pid: number; readonly command: string }>;
  readonly kept: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly timings?: Record<string, number>;
}

interface ExecReply {
  readonly done: boolean;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly timings?: Record<string, number>;
}

const decode = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));

/** A command that left processes running, its fork kept for them. */
interface ProcessHost {
  readonly call: string;
  readonly base: { readonly snapshot: string; readonly seq: number };
  /** Its own commits: they never conflict with it. */
  readonly own: Array<number>;
  diverged?: ReadonlyArray<string>;
}

interface Session {
  readonly name: string;
  /** Mounting, applying and snapshotting the head, one at a time. */
  readonly head: Semaphore.Semaphore;
  /** Landing patches, one batch at a time. */
  readonly commits: Semaphore.Semaphore;
  mounted: boolean;
  usedAt: number;
  /** What changed, in order: `null` when nobody could say. */
  readonly log: Array<{ readonly seq: number; readonly paths: ReadonlyArray<string> | null }>;
  seq: number;
  /** The log's position the head's latest snapshot includes. */
  snapshotSeq: number;
  /** Patches applied since the last snapshot. */
  dirty: boolean;
  readonly opens: Map<string, number>;
  host?: ProcessHost;
  /** Patches waiting to land. */
  readonly queue: Array<Pending>;
  /** Where a fork started, and where each merge into another session left off. */
  origin?: string;
  readonly merged: Map<string, string>;
}

interface Pending {
  readonly base: { readonly snapshot: string; readonly seq: number };
  readonly patch: string;
  readonly summary: PatchSummary;
  readonly call: string;
  readonly done: Deferred.Deferred<
    { readonly changes: WorkspaceChanges; readonly timings: Record<string, number> },
    WorkspaceError
  >;
  readonly queued: number;
}

/** Runs `effect`, adding how long it took to `timings` as `phase`. */
const timed = <A, E, R>(
  timings: Record<string, number>,
  phase: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.map(Effect.timed(effect), ([duration, value]) => {
    timings[phase] = Math.round(((timings[phase] ?? 0) + Duration.toMillis(duration)) * 10) / 10;
    return value;
  });

/** The service: what a host's `fetch` answers. */
export const serveWorkspace = (config: HostConfig) =>
  Effect.gen(function* () {
    const host = yield* ServerHost;
    const services = yield* Effect.context<never>();
    const token = yield* Effect.sync(() => process.env[HOST_TOKEN] ?? "");
    // The daemon's token: anyone who holds the service's can drive it anyway.
    const daemonToken = yield* Effect.sync(() =>
      createHash("sha256").update(`blockd-daemon\n${token}`).digest("hex"),
    );
    const daemon = daemonClient(daemonToken);
    const store = { store: config.store };
    const ready = yield* Deferred.make<void, WorkspaceError>();
    const sessions = new Map<string, Session>();
    const jobs = new Map<
      string,
      { readonly done: Deferred.Deferred<unknown, WorkspaceError>; at: number }
    >();
    const spawns = new Map<string, string>(); // service spawn id → daemon spawn id

    const isolation =
      config.isolation === "none" || !config.image
        ? undefined
        : { runtime: config.isolation, image: config.image, path: config.path };

    //#region setup

    const sh = (script: string, env: Record<string, string> = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make("sh", ["-c", script], {
            env: { ...process.env, ...env } as Record<string, string>,
          });
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [
              handle.exitCode,
              handle.stdout.pipe(Stream.decodeText, Stream.mkString),
              handle.stderr.pipe(Stream.decodeText, Stream.mkString),
            ],
            { concurrency: 3 },
          );
          if (exitCode !== 0) return yield* fail(`setup failed (${exitCode}): ${stderr || stdout}`);
          return stdout;
        }),
      ).pipe(
        Effect.mapError((cause) =>
          (cause as { readonly _tag?: string })._tag === "WorkspaceError"
            ? (cause as WorkspaceError)
            : fail(String(cause), cause),
        ),
      );

    /** blockd and its daemon, installed from the bucket and run by systemd. */
    const setup = sh(
      [
        // What boot installs (runc, gVisor, the kernel's modules) first.
        "for i in $(seq 1 300); do [ -f /run/alchemy-workspace-ready ] && break; sleep 2; done",
        "set -e",
        "arch=$(uname -m)",
        "mkdir -p /usr/local/lib/blockd /var/cache/blockd /run/blockd " + `${HEADS} ${CALLS}`,
        `aws s3 cp --quiet "s3://${config.bucket}/${config.binaries}/blockd-host-$arch" /usr/local/bin/blockd.next`,
        `aws s3 cp --quiet "s3://${config.bucket}/${config.binaries}/blockd-$arch" /usr/local/lib/blockd/init`,
        "chmod 0755 /usr/local/bin/blockd.next /usr/local/lib/blockd/init",
        "mv /usr/local/bin/blockd.next /usr/local/bin/blockd",
        "modprobe ublk_drv 2>/dev/null || true; modprobe nbd nbds_max=64 2>/dev/null || true",
        "cat > /etc/systemd/system/alchemy-blockd.service <<'UNIT'",
        "[Unit]",
        "Description=blockd, the workspace's disks",
        "[Service]",
        `Environment=BLOCKD_DAEMON_TOKEN=${daemonToken}`,
        `Environment=AWS_REGION=${process.env.AWS_REGION ?? ""}`,
        "ExecStart=/usr/local/bin/blockd daemon --listen 127.0.0.1:7681 --pidfile /run/blockd/daemon.pid --state /var/cache/blockd --run /run/blockd --init /usr/local/lib/blockd/init",
        "Restart=always",
        "UNIT",
        "systemctl daemon-reload",
        "systemctl restart alchemy-blockd",
        "for i in $(seq 1 100); do [ -f /run/blockd/daemon.pid ] && exit 0; sleep 0.1; done",
        "journalctl -u alchemy-blockd --no-pager | tail -20 >&2; exit 1",
      ].join("\n"),
    );

    //#endregion

    //#region sessions

    const session = (name: string): Session => {
      let found = sessions.get(name);
      if (!found) {
        found = {
          name,
          head: Semaphore.makeUnsafe(1),
          commits: Semaphore.makeUnsafe(1),
          mounted: false,
          usedAt: Date.now(),
          log: [],
          seq: 0,
          snapshotSeq: 0,
          dirty: false,
          opens: new Map(),
          queue: [],
          merged: new Map(),
        };
        sessions.set(name, found);
      }
      found.usedAt = Date.now();
      return found;
    };

    const headSnapshot = (name: string) =>
      Effect.map(
        daemon.post<{ readonly snapshot: string | null }>("/v1/store/head", {
          ...store,
          head: name,
        }),
        (reply) => reply.snapshot,
      );

    /** The session's head, forked from the base if it's new. */
    const ensureHead = Effect.fn(function* (s: Session) {
      if (s.mounted) return;
      if ((yield* headSnapshot(s.name)) === null) {
        const forked = yield* daemon
          .post<{ readonly snapshot: string }>("/v1/store/fork", {
            ...store,
            from: config.base,
            to: s.name,
          })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (forked) s.origin ??= forked.snapshot;
      }
    });

    /** The session's head mounted here (under its lock). */
    const mount = Effect.fn(function* (s: Session) {
      if (s.mounted) return;
      yield* ensureHead(s);
      yield* daemon.post("/v1/heads", {
        ...store,
        head: s.name,
        dir: `${HEADS}/${s.name}`,
        mode: "auto",
        flushEvery: 5,
        ...(isolation ? { isolation } : {}),
      });
      s.mounted = true;
      // A head mounted from the store has nothing unlanded.
      s.snapshotSeq = s.seq;
      s.dirty = false;
    });

    const appendLog = (s: Session, paths: ReadonlyArray<string> | null) => {
      s.seq += 1;
      s.log.push({ seq: s.seq, paths });
      return s.seq;
    };
    const logSince = (s: Session, seq: number, except: ReadonlyArray<number> = []) =>
      s.log
        .filter((entry) => entry.seq > seq && !except.includes(entry.seq))
        .map((entry) => entry.paths);

    /** Snapshot the head if patches landed since its last one (under its lock). */
    const snapshotIfDirty = Effect.fn(function* (s: Session) {
      if (!s.mounted || !s.dirty) return;
      yield* daemon.post("/v1/heads/" + encodeURIComponent(s.name) + "/snapshot", {
        freeze: `${HEADS}/${s.name}`,
      });
      s.dirty = false;
      s.snapshotSeq = s.seq;
    });

    /** What a fork of the session starts from: everything landed so far. */
    const base = (s: Session) =>
      s.head.withPermits(1)(
        Effect.gen(function* () {
          yield* ensureHead(s);
          if (s.mounted) {
            // What the head's own commands changed counts as changed since now.
            const checkpoint = yield* daemon.post<{ readonly paths: ReadonlyArray<string> | null }>(
              `/v1/heads/${encodeURIComponent(s.name)}/checkpoint`,
            );
            if (checkpoint.paths === null || checkpoint.paths.length > 0) {
              appendLog(s, checkpoint.paths);
              s.dirty = true;
            }
            yield* snapshotIfDirty(s);
          }
          const snapshot = yield* headSnapshot(s.name);
          if (snapshot === null) return yield* fail(`${s.name} has no head`);
          return { snapshot, seq: s.seq };
        }),
      );

    /** Unmount: the head's last snapshot (under its lock). */
    const unmount = Effect.fn(function* (s: Session) {
      if (!s.mounted) return;
      const detached = yield* daemon.post<{ readonly paths: ReadonlyArray<string> | null }>(
        `/v1/heads/${encodeURIComponent(s.name)}/detach`,
      );
      if (detached.paths === null || detached.paths.length > 0) appendLog(s, detached.paths);
      s.mounted = false;
      s.dirty = false;
      s.snapshotSeq = s.seq;
    });

    const deletePatch = (key: string) =>
      Effect.ignore(daemon.post("/v1/store/blob-delete", { ...store, key }));

    const conflictFork = (s: Session, call: string) => `${s.name}.conflict-${call.slice(0, 8)}`;

    /** A refused patch, kept as a session of its own on its base. */
    const adopt = Effect.fn(function* (name: string, at: string, patch: string) {
      yield* daemon.post("/v1/store/fork", { ...store, at, to: name });
      const dir = `${HEADS}/${name}`;
      yield* daemon.post("/v1/heads", { ...store, head: name, dir, mode: "auto", flushEvery: 0 });
      yield* daemon
        .post(`/v1/heads/${encodeURIComponent(name)}/apply`, { patches: [patch] })
        .pipe(
          Effect.ensuring(
            Effect.ignore(daemon.post(`/v1/heads/${encodeURIComponent(name)}/detach`)),
          ),
        );
      const forked = session(name);
      forked.origin = at;
    });

    /**
     * Land every waiting patch on the head, in order: each is refused (and
     * kept as a fork) if it changed a path changed since its base. The rest
     * are applied together and journaled; the snapshot comes later, before
     * the next fork that needs it.
     */
    const drain = Effect.fn(function* (s: Session) {
      const batch = s.queue.splice(0);
      if (batch.length === 0) return;
      const started = Date.now();
      const timings: Record<string, number> = {};
      const finish = (pending: Pending) => ({
        ...timings,
        "commit.queue": started - pending.queued,
        "commit.batch": batch.length,
      });
      const landed = s.head.withPermits(1)(
        Effect.gen(function* () {
          yield* timed(timings, "commit.head", mount(s));
          const checkpoint = yield* timed(
            timings,
            "commit.checkpoint",
            daemon.post<{ readonly paths: ReadonlyArray<string> | null }>(
              `/v1/heads/${encodeURIComponent(s.name)}/checkpoint`,
            ),
          );
          if (checkpoint.paths === null || checkpoint.paths.length > 0)
            appendLog(s, checkpoint.paths);
          const accepted: Array<Pending> = [];
          const refused: Array<{
            readonly pending: Pending;
            readonly paths: ReadonlyArray<string>;
          }> = [];
          for (const pending of batch) {
            const clashes = conflicts(
              pending.summary.paths,
              logSince(s, pending.base.seq),
              config.lww,
            );
            if (clashes.length > 0) {
              refused.push({ pending, paths: clashes });
              continue;
            }
            accepted.push(pending);
            appendLog(s, pending.summary.paths);
          }
          if (accepted.length > 0) {
            yield* timed(
              timings,
              "commit.apply",
              daemon.post(`/v1/heads/${encodeURIComponent(s.name)}/apply`, {
                patches: accepted.map((pending) => pending.patch),
              }),
            );
            // Durable now; the snapshot waits for the next fork.
            yield* timed(
              timings,
              "commit.sync",
              daemon.post(`/v1/heads/${encodeURIComponent(s.name)}/sync`),
            );
            s.dirty = true;
            for (const pending of accepted) {
              yield* deletePatch(pending.patch);
              yield* Deferred.succeed(pending.done, {
                changes: { status: "applied", paths: pending.summary.paths },
                timings: finish(pending),
              });
            }
          }
          for (const { pending, paths } of refused) {
            const fork = conflictFork(s, pending.call);
            const adopted = yield* Effect.exit(adopt(fork, pending.base.snapshot, pending.patch));
            yield* deletePatch(pending.patch);
            yield* Deferred.succeed(pending.done, {
              changes:
                adopted._tag === "Success"
                  ? { status: "conflict", paths, fork }
                  : { status: "conflict", paths },
              timings: finish(pending),
            });
          }
        }),
      );
      const exit = yield* Effect.exit(landed);
      if (exit._tag === "Failure") {
        for (const pending of batch) yield* Deferred.failCause(pending.done, exit.cause as never);
      }
    });

    const commit = Effect.fn(function* (
      s: Session,
      pendingBase: { readonly snapshot: string; readonly seq: number },
      patch: string,
      summary: PatchSummary,
      call: string,
    ) {
      const done = yield* Deferred.make<
        { readonly changes: WorkspaceChanges; readonly timings: Record<string, number> },
        WorkspaceError
      >();
      s.queue.push({ base: pendingBase, patch, summary, call, done, queued: Date.now() });
      yield* s.commits.withPermits(1)(drain(s));
      return yield* Deferred.await(done);
    });

    //#endregion

    //#region process hosts

    /** Land one of a host's commits, unless it conflicts. */
    const landHost = Effect.fn(function* (
      s: Session,
      h: ProcessHost,
      reply: { readonly patch?: string | null; readonly summary: PatchSummary },
    ) {
      if (!reply.patch) return { status: "applied", paths: [] } satisfies WorkspaceChanges;
      if (h.diverged) {
        yield* deletePatch(reply.patch);
        return {
          status: "conflict",
          paths: h.diverged,
          fork: conflictFork(s, h.call),
        } satisfies WorkspaceChanges;
      }
      return yield* s.head.withPermits(1)(
        Effect.gen(function* () {
          yield* mount(s);
          const checkpoint = yield* daemon.post<{ readonly paths: ReadonlyArray<string> | null }>(
            `/v1/heads/${encodeURIComponent(s.name)}/checkpoint`,
          );
          if (checkpoint.paths === null || checkpoint.paths.length > 0)
            appendLog(s, checkpoint.paths);
          const clashes = conflicts(
            reply.summary.paths,
            logSince(s, h.base.seq, h.own),
            config.lww,
          );
          if (clashes.length > 0) {
            yield* deletePatch(reply.patch!);
            h.diverged = clashes;
            return {
              status: "conflict",
              paths: clashes,
              fork: conflictFork(s, h.call),
            } satisfies WorkspaceChanges;
          }
          yield* daemon.post(`/v1/heads/${encodeURIComponent(s.name)}/apply`, {
            patches: [reply.patch],
          });
          yield* daemon.post(`/v1/heads/${encodeURIComponent(s.name)}/sync`);
          h.own.push(appendLog(s, reply.summary.paths));
          s.dirty = true;
          yield* deletePatch(reply.patch!);
          return { status: "applied", paths: reply.summary.paths } satisfies WorkspaceChanges;
        }),
      );
    });

    /** The host's processes are done (or it's dropped): its last changes. */
    const endHost = Effect.fn(function* (s: Session, h: ProcessHost, keep: boolean) {
      const key = `patches/${s.name}/${h.call}-last-${Date.now()}`;
      let changes: WorkspaceChanges = { status: "applied", paths: [] };
      if (keep && h.diverged) {
        const full = yield* daemon.post<{ readonly patch?: string | null }>(
          `/v1/calls/${h.call}/commit`,
          {
            patch: `${key}-full`,
            full: true,
          },
        );
        const detached = yield* daemon.post<{ readonly patch?: string | null }>(
          `/v1/calls/${h.call}/detach`,
          { patch: key },
        );
        if (detached.patch) yield* deletePatch(detached.patch);
        if (full.patch)
          yield* Effect.ignore(adopt(conflictFork(s, h.call), h.base.snapshot, full.patch));
        changes = { status: "conflict", paths: h.diverged, fork: conflictFork(s, h.call) };
      } else {
        const detached = yield* daemon.post<{
          readonly patch?: string | null;
          readonly summary?: PatchSummary;
        }>(`/v1/calls/${h.call}/detach`, { patch: key });
        if (keep) {
          changes = yield* landHost(s, h, {
            patch: detached.patch ?? null,
            summary: detached.summary ?? { paths: [], bytes: 0, operations: 0 },
          });
        } else if (detached.patch) yield* deletePatch(detached.patch);
      }
      s.host = undefined;
      return changes;
    });

    /** Commit what changed on the host; end it once its processes are done. */
    const syncHost = Effect.fn(function* (s: Session) {
      const h = s.host;
      if (!h) return undefined;
      const reply = yield* daemon.post<{
        readonly patch?: string | null;
        readonly summary: PatchSummary;
        readonly survivors: ReadonlyArray<unknown>;
      }>(`/v1/calls/${h.call}/commit`, { patch: `patches/${s.name}/${h.call}-${Date.now()}` });
      const landed = yield* landHost(s, h, reply);
      if (reply.survivors.length > 0) return landed;
      const last = yield* endHost(s, h, true);
      return last.paths.length > 0 || last.status === "conflict" ? last : landed;
    });

    //#endregion

    //#region commands

    const toResult = (reply: ExecReply | CallReply) => ({
      exitCode: reply.exitCode,
      stdout: decode(reply.stdout),
      stderr: decode(reply.stderr),
    });

    const pinned = Effect.fn(function* (s: Session, body: ServiceExecBody) {
      const timings: Record<string, number> = {};
      yield* timed(timings, "head", s.head.withPermits(1)(mount(s)));
      const { id } = yield* daemon.post<{ readonly id: string }>(
        `/v1/heads/${encodeURIComponent(s.name)}/exec`,
        body,
      );
      const reply = yield* timed(timings, "run", daemon.wait<ExecReply>(id));
      const changes = yield* s.head.withPermits(1)(
        Effect.gen(function* () {
          const checkpoint = yield* daemon.post<{ readonly paths: ReadonlyArray<string> | null }>(
            `/v1/heads/${encodeURIComponent(s.name)}/checkpoint`,
          );
          if (checkpoint.paths === null || checkpoint.paths.length > 0) {
            appendLog(s, checkpoint.paths);
            s.dirty = true;
          }
          const snapshot = yield* daemon.post<{ readonly snapshot: string }>(
            `/v1/heads/${encodeURIComponent(s.name)}/snapshot`,
            { freeze: `${HEADS}/${s.name}` },
          );
          s.dirty = false;
          s.snapshotSeq = s.seq;
          return {
            status: "applied",
            snapshot: snapshot.snapshot,
            paths: checkpoint.paths ?? [],
          } satisfies WorkspaceChanges;
        }),
      );
      return {
        ...toResult(reply),
        changes,
        timings: { ...timings, ...prefixed("blockd.", reply.timings) },
      } satisfies WorkspaceExecResult;
    });

    const prefixed = (prefix: string, from: Record<string, number> | undefined) =>
      Object.fromEntries(
        Object.entries(from ?? {}).map(([phase, ms]) => [`${prefix}${phase}`, ms]),
      );

    /** A command on the session's process host, beside what it keeps running. */
    const onHost = Effect.fn(function* (s: Session, h: ProcessHost, body: ServiceExecBody) {
      const { id } = yield* daemon.post<{ readonly id: string }>(`/v1/calls/${h.call}/exec`, body);
      const reply = yield* daemon.wait<ExecReply>(id);
      const changes = (yield* s.commits.withPermits(1)(syncHost(s))) ?? {
        status: "applied",
        paths: [],
      };
      return { ...toResult(reply), changes } satisfies WorkspaceExecResult;
    });

    /** A command on a fork of the session, merged back. */
    const forked = Effect.fn(function* (s: Session, body: ServiceExecBody) {
      if (config.placement === "automatic" && s.host) return yield* onHost(s, s.host, body);
      const timings: Record<string, number> = {};
      const from = yield* timed(timings, "base", base(s));
      const call = crypto.randomUUID();
      const patch = `patches/${s.name}/${call}`;
      const keep = config.placement === "automatic";
      const { id } = yield* daemon.post<{ readonly id: string }>("/v1/calls", {
        ...store,
        snapshot: from.snapshot,
        dir: `${CALLS}/${call}`,
        mode: "auto",
        patch,
        ...body,
        ...(keep ? { keep } : {}),
        ...(isolation ? { isolation } : {}),
      });
      const reply = yield* timed(timings, "call", daemon.wait<CallReply>(id));
      Object.assign(timings, prefixed("blockd.", reply.timings));
      if (reply.kept) {
        const h: ProcessHost = { call: id, base: from, own: [] };
        s.host = h;
        const changes = yield* timed(
          timings,
          "commit",
          s.commits.withPermits(1)(landHost(s, h, { patch: reply.patch, summary: reply.summary })),
        );
        return { ...toResult(reply), changes, timings } satisfies WorkspaceExecResult;
      }
      let changes: WorkspaceChanges = { status: "applied", paths: [] };
      if (reply.patch) {
        const landed = yield* timed(
          timings,
          "commit",
          commit(s, from, reply.patch, reply.summary, call),
        );
        changes = landed.changes;
        Object.assign(timings, landed.timings);
      }
      return {
        ...toResult(reply),
        changes,
        ...(reply.survivors.length > 0 ? { stopped: reply.survivors } : {}),
        timings,
      } satisfies WorkspaceExecResult;
    });

    const exec = (
      name: string,
      body: ServiceExecBody,
    ): Effect.Effect<WorkspaceExecResult, WorkspaceError> => {
      const s = session(name);
      return (config.placement === "pinned" ? pinned(s, body) : forked(s, body)) as Effect.Effect<
        WorkspaceExecResult,
        WorkspaceError
      >;
    };

    /** Merge what `from` changed since its fork (or the last merge) into `into`. */
    const merge = Effect.fn(function* (fromName: string, intoName: string) {
      const from = session(fromName);
      const into = session(intoName);
      const since = into.merged.get(fromName) ?? from.origin;
      if (!since) return yield* fail(`${fromName} has no fork point to merge from`);
      const fromNow = yield* base(from);
      const intoNow = yield* base(into);
      const patchKey = `patches/${intoName}/merge-${crypto.randomUUID()}`;
      const diff = yield* daemon.post<{
        readonly patch?: string | null;
        readonly summary: PatchSummary;
      }>("/v1/diffs", {
        ...store,
        from: since,
        to: fromNow.snapshot,
        patch: patchKey,
        mode: "auto",
      });
      into.merged.set(fromName, fromNow.snapshot);
      if (!diff.patch) return { status: "applied", paths: [] } satisfies WorkspaceChanges;
      // Conflicts: what `into` changed since the same fork point.
      const theirs = yield* daemon.post<{ readonly summary: PatchSummary }>("/v1/diffs", {
        ...store,
        from: since,
        to: intoNow.snapshot,
        mode: "auto",
      });
      const clashes = conflicts(diff.summary.paths, [theirs.summary.paths], config.lww);
      if (clashes.length > 0) {
        yield* deletePatch(diff.patch);
        into.merged.delete(fromName);
        return { status: "conflict", paths: clashes } satisfies WorkspaceChanges;
      }
      return (yield* commit(into, intoNow, diff.patch, diff.summary, crypto.randomUUID())).changes;
    });

    //#endregion

    //#region jobs

    /** Run `effect` detached; its result is a job anyone can wait on. */
    const startJob = <A>(effect: Effect.Effect<A, WorkspaceError, never>) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const done = yield* Deferred.make<unknown, WorkspaceError>();
        jobs.set(id, { done, at: Date.now() });
        yield* Effect.forkDetach(
          Effect.exit(effect).pipe(Effect.flatMap((exit) => Deferred.done(done, exit as never))),
        );
        return id;
      });

    const waitJob = Effect.fn(function* (id: string, waitMs: number) {
      const job = jobs.get(id);
      if (!job) return yield* fail(`no job ${id}`);
      const exit = yield* Deferred.await(job.done).pipe(
        Effect.exit,
        Effect.timeoutOption(Duration.millis(Math.min(waitMs, WAIT_MS))),
      );
      if (exit._tag === "None") return { done: false };
      job.at = Date.now();
      return exit.value._tag === "Success"
        ? { done: true, result: exit.value.value }
        : {
            done: true,
            error: String(
              (exit.value.cause as { readonly message?: string })?.message ?? exit.value.cause,
            ),
          };
    });

    //#endregion

    //#region opens

    const open = Effect.fn(function* (name: string) {
      const s = session(name);
      yield* s.head.withPermits(1)(mount(s));
      const id = crypto.randomUUID();
      s.opens.set(id, Date.now() + OPEN_TTL);
      return { open: `${name}~${id}`, dir: config.path };
    });

    const opened = (open: string) => {
      const [name, id] = open.split("~");
      const s = name ? sessions.get(name) : undefined;
      if (!s || !id || !s.opens.has(id)) return undefined;
      return { s, id };
    };

    const release = Effect.fn(function* (s: Session, id: string) {
      s.opens.delete(id);
      if (s.opens.size > 0) return;
      // The last open's end is a snapshot, as an open promises.
      yield* s.head.withPermits(1)(
        Effect.gen(function* () {
          if (!s.mounted) return;
          const checkpoint = yield* daemon.post<{ readonly paths: ReadonlyArray<string> | null }>(
            `/v1/heads/${encodeURIComponent(s.name)}/checkpoint`,
          );
          if (checkpoint.paths === null || checkpoint.paths.length > 0)
            appendLog(s, checkpoint.paths);
          yield* daemon.post(`/v1/heads/${encodeURIComponent(s.name)}/snapshot`, {
            freeze: `${HEADS}/${s.name}`,
          });
          s.dirty = false;
          s.snapshotSeq = s.seq;
        }),
      );
    });

    //#endregion

    //#region housekeeping

    /** Every few seconds: kept calls commit, idle heads unmount, old jobs go. */
    const tick = Effect.gen(function* () {
      const now = Date.now();
      for (const [id, job] of jobs) {
        if (now - job.at > KEEP_JOBS && (yield* Deferred.isDone(job.done))) jobs.delete(id);
      }
      for (const s of sessions.values()) {
        for (const [id, expires] of s.opens)
          if (expires < now) yield* Effect.ignore(release(s, id));
        if (s.host) yield* Effect.ignore(s.commits.withPermits(1)(syncHost(s)));
        if (s.mounted && !s.host && s.opens.size === 0 && now - s.usedAt > config.idleMs) {
          yield* Effect.ignore(s.head.withPermits(1)(unmount(s)));
        }
      }
    });

    //#endregion

    //#region http

    const respond = (status: number, body: unknown) =>
      HttpServerResponse.json(body, { status }).pipe(Effect.orDie);

    const handle = Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://workspace");
      const path = url.pathname;
      if (path === "/health") return yield* respond(200, { ok: true });
      const given = request.headers["authorization"]?.replace(/^Bearer /, "");
      if (!token || given !== token)
        return yield* respond(401, { error: "a bad or missing token" });
      yield* Deferred.await(ready);
      const segments = path.split("/").filter(Boolean);
      const body = (
        request.method === "POST" && !path.includes("/ports/")
          ? yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
          : {}
      ) as Record<string, any>;
      const sessionName = (field = "session") => {
        const name = String(body[field] ?? "");
        return validSession(name)
          ? Effect.succeed(name)
          : Effect.fail(fail(`a bad session name: ${name}`));
      };
      const routed: Effect.Effect<unknown, WorkspaceError> = (() => {
        switch (
          `${request.method} /${segments.slice(0, 2).join("/")}${segments.length > 2 ? "/*" : ""}`
        ) {
          case "POST /v1/exec":
            return Effect.flatMap(sessionName(), (name) =>
              Effect.map(startJob(exec(name, body as ServiceExecBody)), (job) => ({ job })),
            );
          case "GET /v1/jobs/*":
            return waitJob(segments[2]!, Number(url.searchParams.get("wait") ?? 0));
          case "POST /v1/merge":
            return Effect.flatMap(
              Effect.all([sessionName("from"), sessionName("into")]),
              ([from, into]) => Effect.map(merge(from, into), (changes) => ({ changes })),
            );
          case "POST /v1/fork":
            return Effect.flatMap(
              Effect.all([sessionName("from"), sessionName("to")]),
              ([from, to]) =>
                Effect.gen(function* () {
                  const source = yield* base(sessions.get(from) ?? session(from));
                  yield* daemon.post("/v1/store/fork", { ...store, at: source.snapshot, to });
                  session(to).origin = source.snapshot;
                  return {};
                }),
            );
          case "POST /v1/undo":
            return Effect.flatMap(sessionName(), (name) =>
              Effect.gen(function* () {
                const s = session(name);
                if (s.host) yield* endHost(s, s.host, false);
                return yield* s.head.withPermits(1)(
                  Effect.gen(function* () {
                    yield* unmount(s);
                    const { history } = yield* daemon.post<{
                      readonly history: ReadonlyArray<string>;
                    }>("/v1/store/history", {
                      ...store,
                      head: name,
                      limit: Number(body.steps ?? 1) + 1,
                    });
                    const to = history[Number(body.steps ?? 1)];
                    if (!to)
                      return yield* fail(
                        `${name} has fewer than ${body.steps ?? 1} snapshots to go back`,
                      );
                    yield* daemon.post("/v1/store/reset", { ...store, head: name, to });
                    // Nothing logged before the rewind is a base anymore.
                    appendLog(s, null);
                    return {};
                  }),
                );
              }),
            );
          case "POST /v1/history":
            return Effect.flatMap(sessionName(), (name) =>
              Effect.gen(function* () {
                const s = sessions.get(name);
                if (s) yield* s.head.withPermits(1)(snapshotIfDirty(s));
                return yield* daemon
                  .post<{ readonly history: ReadonlyArray<string> }>("/v1/store/history", {
                    ...store,
                    head: name,
                    limit: Number(body.limit ?? 20),
                  })
                  .pipe(Effect.catch(() => Effect.succeed({ history: [] })));
              }),
            );
          case "POST /v1/delete":
            return Effect.flatMap(sessionName(), (name) =>
              Effect.gen(function* () {
                const s = sessions.get(name);
                if (s) {
                  if (s.host) yield* Effect.ignore(endHost(s, s.host, false));
                  yield* Effect.ignore(s.head.withPermits(1)(unmount(s)));
                  sessions.delete(name);
                }
                yield* daemon.post("/v1/store/drop", { ...store, head: name });
                return {};
              }),
            );
          case "POST /v1/opens":
            return Effect.flatMap(sessionName(), open);
          case "POST /v1/opens/*": {
            const held = opened(segments[2]!);
            if (!held) return Effect.fail(fail(`no open ${segments[2]}`));
            const head = `/v1/heads/${encodeURIComponent(held.s.name)}`;
            switch (segments[3]) {
              case "renew":
                held.s.opens.set(held.id, Date.now() + OPEN_TTL);
                held.s.usedAt = Date.now();
                return Effect.succeed({});
              case "release":
                return Effect.as(release(held.s, held.id), {});
              case "exec":
                return Effect.map(
                  startJob(
                    Effect.flatMap(
                      daemon.post<{ readonly id: string }>(`${head}/exec`, body),
                      ({ id }) => Effect.map(daemon.wait<ExecReply>(id), toResult),
                    ),
                  ),
                  (job) => ({ job }),
                );
              case "spawn":
                return Effect.map(
                  daemon.post<{ readonly id: string; readonly pid: number }>(`${head}/spawn`, body),
                  (spawned) => {
                    const id = crypto.randomUUID();
                    spawns.set(id, spawned.id);
                    return { spawn: id, pid: spawned.pid };
                  },
                );
              default:
                return Effect.fail(fail(`no open operation ${segments[3]}`));
            }
          }
          case "GET /v1/spawns/*": {
            const spawned = spawns.get(segments[2]!);
            if (!spawned) return Effect.fail(fail(`no process ${segments[2]}`));
            return daemon.get(`/v1/spawns/${spawned}${url.search}`);
          }
          case "POST /v1/spawns/*": {
            const spawned = spawns.get(segments[2]!);
            if (!spawned) return Effect.fail(fail(`no process ${segments[2]}`));
            return daemon.post(`/v1/spawns/${spawned}/kill`, body);
          }
          default:
            return Effect.fail(fail(`no route ${request.method} ${path}`));
        }
      })();
      // A port inside an open session: proxied, streamed.
      if (segments[0] === "v1" && segments[1] === "opens" && segments[3] === "ports") {
        const held = opened(segments[2]!);
        if (!held) return yield* respond(404, { error: `no open ${segments[2]}` });
        const target = `http://127.0.0.1:${Number(segments[4])}/${segments.slice(5).join("/")}${url.search}`;
        const forwarded = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          return yield* client.execute(
            HttpServerRequestModule.toClientRequest(request).pipe(
              HttpClientRequest.setUrl(target),
              HttpClientRequest.removeHeader("authorization"),
            ),
          );
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.result);
        if (forwarded._tag === "Failure")
          return yield* respond(502, { error: forwarded.failure.message });
        return HttpServerResponse.stream(forwarded.success.stream, {
          status: forwarded.success.status,
          headers: forwarded.success.headers,
        });
      }
      const outcome = yield* Effect.result(routed);
      return outcome._tag === "Success"
        ? yield* respond(200, outcome.success)
        : yield* respond(500, { error: outcome.failure.message });
    }).pipe(
      Effect.catch((error) => respond(503, { error: error.message })),
      Effect.provide(services),
    );

    if (globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.run(
        Effect.gen(function* () {
          yield* setup.pipe(
            Effect.retry({ schedule: Schedule.spaced(Duration.seconds(5)), times: 10 }),
            Effect.flatMap(() => Deferred.succeed(ready, undefined)),
            Effect.catch((error) =>
              Effect.andThen(Effect.logError(error.message), Deferred.fail(ready, error)),
            ),
          );
          yield* Effect.ignore(tick).pipe(Effect.repeat(Schedule.spaced(HOST_SYNC)));
        }).pipe(Effect.asVoid),
      );
    }

    return { fetch: handle };
  });
