import type { SandboxClient, SandboxProcess } from "@alchemy.run/sandbox/Sandbox";
import { SandboxError } from "@alchemy.run/sandbox/Sandbox";
import {
  Volume as VolumeDeclaration,
  type ChangedPaths,
  type Disk,
  type DiskHostCommit,
  type DiskMount,
  type DiskSurvivor,
  type PatchSummary,
  type Snapshot,
} from "@alchemy.run/sandbox/Volume";
import {
  WorkspaceError,
  type WorkspaceChanges,
  type WorkspaceExecResult,
} from "@alchemy.run/sandbox/Workspace";
/**
 * The Durable Objects behind `Cloudflare.Containers.Workspace`, and the host
 * Worker that serves them. Runtime code only: the host Worker's bundle
 * imports this module (through WorkspaceHost.ts), so nothing here may pull in
 * deploy-time resources.
 *
 * NOT exported from `index.ts`.
 */
import type * as cf from "@cloudflare/workers-types";
import { canonicalJson } from "alchemy/Egress/Canonical";
import { registerGatewayClient } from "alchemy/Egress/Clients";
import type { GatewayClient } from "alchemy/Egress/Gateway";
import type { EgressRef, MintedGrant } from "alchemy/Egress/Kind";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerRequestModule from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { DurableObject } from "../Workers/DurableObject.ts";
import type { DurableObject as DurableObjectNamespace } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { volumeBucketBinding } from "../Workers/VolumeHeads.ts";
import { Worker } from "../Workers/Worker.ts";
import { WorkerEnvironment } from "../Workers/WorkerRuntime.ts";
import { Container } from "./Container.ts";
import type { ContainerClient } from "./ContainerClient.ts";
import { registerControl } from "./EgressRelay.ts";
import type { ContainerInstanceType } from "./SandboxClient.ts";
import { conflicts } from "./WorkspaceMerge.ts";
import { className, machineSandbox } from "./WorkspaceNames.ts";

/** The `host` of a workspace's descriptor. */
export const WORKSPACE_HOST = "Cloudflare.Containers.Workspace";

/** The host a machine's blockd reads and moves heads through. */
const HEADS_HOST = "workspace.alchemy.internal";

/** The env var holding a host Worker's {@link HostConfig}. */
export const HOST_CONFIG = "ALCHEMY_WORKSPACE_HOST";

/**
 * The env var holding the secret a machine off Cloudflare (a MicroVM)
 * presents to the host Worker's `/heads` and `/journal` endpoints.
 */
export const HOST_TOKEN = "ALCHEMY_WORKSPACE_TOKEN";

/** How long a lease lives without renewal: an `open` renews it while it runs. */
const LEASE_TTL = Duration.minutes(2);

/** What a Worker that yields the workspace needs to reach its host. */
export interface WorkspaceHostDescriptor {
  readonly host: typeof WORKSPACE_HOST;
  /** The host Worker's script name. */
  readonly script: string;
  readonly id: string;
  /** The host Worker's URL: machines off Cloudflare reach their session through it. */
  readonly url?: string;
}

/** @internal What the host Worker is configured with, the same at deploy and at run time. */
export interface HostConfig {
  readonly id: string;
  readonly path: string;
  readonly instanceType: ContainerInstanceType;
  readonly idleMs: number;
  /** What machines run on. */
  readonly machine: "container" | "lambda";
  /** Snapshots kept per session by garbage collection; all when absent. */
  readonly history?: number;
  /** Where `exec` runs: on the session's machine, or on a fork anywhere. */
  readonly placement: "pinned" | "serverless" | "automatic";
  /** Machines shared by every session. */
  readonly pool: {
    /** Machines kept started while idle. */
    readonly min: number;
    readonly max: number;
    /** A machine is replaced after this many sessions. */
    readonly retireAfter: number;
  };
  /** Paths where the newest change wins (the declaration's `lww`). */
  readonly lww: ReadonlyArray<string>;
}

/** The one cache file a machine keeps blocks in, for every head and call. */
const CACHE = "/var/cache/blockd/volume.cache";

/** How long the head stays mounted after a merge, for the next one. */
const INTEGRATOR_IDLE = Duration.seconds(20);

/** The lease a session's merges hold on its mount. */
const INTEGRATOR = "integrator";

/** The session a refused command's changes are kept in. */
const conflictFork = (session: string, call: string) => `${session}.conflict-${call.slice(0, 8)}`;

/** Options for one command. */
interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

/** How often a machine collects the store's garbage, at most. */
const GC_EVERY = Duration.hours(6);

/**
 * The egress an `open` grants its commands: the refs, and the grants the
 * yielding Worker minted for them with its own gateway clients (this Worker
 * has none). Renewed with the lease, before they expire.
 */
export interface DelegatedEgress {
  readonly refs: ReadonlyArray<EgressRef>;
  readonly minted: Readonly<Record<string, MintedGrant>>;
  readonly ttlMs: number;
}

/** A lease on a session's mount: plain data, so it crosses requests. */
interface Lease {
  readonly lease: string;
  readonly machine: string;
  readonly dir: string;
}

interface ExecOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a session's Durable Object answers. */
interface SessionShape {
  /** blockd's head requests, from its machine: `get` or `cas` (see volume::store::HttpMetaStore). */
  heads(
    session: string,
    method: "GET" | "POST",
    body: string,
  ): Effect.Effect<{ readonly status: number; readonly body: string }, never, RuntimeContext>;
  /**
   * blockd's journal requests, from its machine (see
   * volume::store::HttpJournalStore): an append is written only if its
   * position is free and its epoch still holds the head, in one step.
   */
  journal(
    session: string,
    request: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly epoch: number;
      readonly seq: number;
      readonly to?: number;
      readonly body?: Uint8Array;
    },
  ): Effect.Effect<{ readonly status: number; readonly body?: Uint8Array }, never, RuntimeContext>;
  acquire(
    session: string,
    grant: string,
    egress: DelegatedEgress | undefined,
    hostUrl: string | undefined,
  ): Effect.Effect<Lease, WorkspaceError, RuntimeContext>;
  renew(
    session: string,
    lease: string,
    egress: DelegatedEgress | undefined,
  ): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  release(session: string, lease: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  /** One command, where the host's placement says. */
  run(
    session: string,
    command: string,
    options: RunOptions,
    grant: string,
    egress: DelegatedEgress | undefined,
    hostUrl: string | undefined,
  ): Effect.Effect<WorkspaceExecResult, WorkspaceError, RuntimeContext>;
  /** Merge what `from` changed since it forked into this session. */
  merge(
    session: string,
    from: string,
    hostUrl: string | undefined,
  ): Effect.Effect<WorkspaceChanges, WorkspaceError, RuntimeContext>;
  /** Become a session on `snapshot` with `patch` applied (a refused command's fork). */
  adopt(
    session: string,
    snapshot: Snapshot,
    patch: string,
    hostUrl: string | undefined,
  ): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  fork(session: string, from: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  undo(session: string, steps: number): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  history(
    session: string,
    limit: number,
  ): Effect.Effect<ReadonlyArray<Snapshot>, WorkspaceError, RuntimeContext>;
  remove(session: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
}

/** What a session's machine answers. */
interface MachineShape {
  mount(
    session: string,
    config: HostConfig,
    egress: DelegatedEgress | undefined,
    hostUrl: string | undefined,
  ): Effect.Effect<{ readonly dir: string }, WorkspaceError, RuntimeContext>;
  /** Fresh grants for the running mount's egress. */
  refresh(egress: DelegatedEgress): Effect.Effect<void, never, RuntimeContext>;
  exec(
    command: string,
    options: {
      readonly cwd: string;
      readonly env?: Record<string, string>;
      readonly timeoutMs?: number;
    },
  ): Effect.Effect<ExecOutput, WorkspaceError, RuntimeContext>;
  unmount(
    session: string,
  ): Effect.Effect<
    { readonly snapshot: Snapshot | undefined; readonly paths: ChangedPaths },
    WorkspaceError,
    RuntimeContext
  >;
  /** The mounted head's changes since its last checkpoint. */
  checkpoint(session: string): Effect.Effect<ChangedPaths, WorkspaceError, RuntimeContext>;
  /** Checkpoint, then apply patches to the mounted head. */
  apply(
    session: string,
    patches: ReadonlyArray<string>,
  ): Effect.Effect<
    { readonly paths: ChangedPaths; readonly applied: ReadonlyArray<PatchSummary> },
    WorkspaceError,
    RuntimeContext
  >;
  /** Snapshot the mounted head, frozen for the moment it takes. */
  snapshot(session: string): Effect.Effect<Snapshot, WorkspaceError, RuntimeContext>;
  /** Grant the running mount's commands `egress` (an open joining a merge's mount). */
  grant(
    config: HostConfig,
    egress: DelegatedEgress | undefined,
  ): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  /**
   * A command on an ephemeral fork of `snapshot`; its patch goes to
   * `patch`. With `keep`, processes it leaves running keep the fork (and
   * this machine): `kept` says so, and `hostCommit`/`hostDetach` follow.
   */
  call(
    snapshot: Snapshot,
    command: string,
    options: RunOptions & { readonly patch: string; readonly keep?: boolean },
    config: HostConfig,
    egress: DelegatedEgress | undefined,
  ): Effect.Effect<
    {
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly patch?: string;
      readonly summary: PatchSummary;
      readonly survivors: ReadonlyArray<DiskSurvivor>;
      readonly kept: boolean;
    },
    WorkspaceError,
    RuntimeContext
  >;
  /** The kept call's changes since its last commit (`full`: since its fork). */
  hostCommit(
    patch: string,
    full: boolean,
  ): Effect.Effect<DiskHostCommit, WorkspaceError, RuntimeContext>;
  /** Stop the kept call's processes, commit the rest, and free the machine. */
  hostDetach(patch: string): Effect.Effect<DiskHostCommit, WorkspaceError, RuntimeContext>;
  /** A patch from `from` to `to` (uploaded to `patch` if given). */
  diff(
    from: Snapshot,
    to: Snapshot,
    patch: string | undefined,
    config: HostConfig,
  ): Effect.Effect<
    { readonly patch?: string; readonly summary: PatchSummary },
    WorkspaceError,
    RuntimeContext
  >;
  /** Start the machine (a warm one in the pool) without mounting anything. */
  warm(config: HostConfig): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  /** Stop the machine for good: the pool replaces it. */
  retire(): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  /** Start `command` in the background; its output goes to files `read` returns. */
  spawn(
    command: string,
    options: { readonly cwd: string; readonly env?: Record<string, string> },
  ): Effect.Effect<{ readonly id: string; readonly pid: number }, WorkspaceError, RuntimeContext>;
  /** A spawned process's output from `offset` on, and its exit code once it has one. */
  read(
    id: string,
    stream: "out" | "err",
    offset: number,
  ): Effect.Effect<
    { readonly data: Uint8Array; readonly exitCode: number | undefined },
    WorkspaceError,
    RuntimeContext
  >;
  kill(id: string, signal: number): Effect.Effect<void, WorkspaceError, RuntimeContext>;
}

/** What the pool answers: machines shared by every session. */
interface PoolShape {
  /** A free machine, preferring the one `session` used last; waits while all are busy. */
  claim(session: string | undefined): Effect.Effect<string, WorkspaceError, RuntimeContext>;
  release(machine: string, session: string | undefined): Effect.Effect<void, never, RuntimeContext>;
  /** A machine held for a long open is still in use. */
  touch(machine: string): Effect.Effect<void, never, RuntimeContext>;
}

/** @internal The workspace's machine pool: one Durable Object. */
export const poolObject = (id: string) =>
  DurableObject<PoolShape, PoolShape>()(className(id, "Pool"), {
    errors: [WorkspaceError],
  });

/** @internal The workspace's sessions, one Durable Object each. */
export const sessionObject = (id: string) =>
  DurableObject<SessionShape, SessionShape>()(className(id, "Session"), {
    errors: [WorkspaceError],
  });

/** @internal The workspace's machines, one Durable Object (and container) each. */
export const machineObject = (id: string) =>
  DurableObject<MachineShape, MachineShape>()(className(id, "Machine"), {
    errors: [WorkspaceError],
  });

/** @internal The volume the sessions' disks are heads of. */
export const volumeOf = (id: string) => VolumeDeclaration<any>()(id);

/** The image commands run in: the user's, kept running for `exec`. */
const machineContainer = (id: string, dockerfile?: string) =>
  Container(className(id, "Box"), {
    schedulingPolicy: "durable_object",
    ...(dockerfile
      ? { dockerfile: { content: `${dockerfile}\nCMD ["sleep", "infinity"]\n` } }
      : {}),
  });

const fail = (message: string, cause?: unknown) => new WorkspaceError({ message, cause });

//#region delegated egress

/** Answered where a gateway client's `EgressGatewayError` would be. */
class DelegatedGrantMissing extends Data.TaggedError("EgressGatewayError")<{
  readonly message: string;
  readonly gateway: string;
}> {}

/** Grants the workspace's callers minted, by gateway and refs, for this isolate's machines. */
const delegated = new Map<string, MintedGrant>();
const delegatedKey = (gateway: string, refs: ReadonlyArray<EgressRef>) =>
  `${gateway}\n${canonicalJson(refs)}`;

const byGateway = (refs: ReadonlyArray<EgressRef>) => {
  const grouped = new Map<string, Array<EgressRef>>();
  for (const ref of refs) grouped.set(ref.gateway, [...(grouped.get(ref.gateway) ?? []), ref]);
  return grouped;
};

/**
 * A gateway client that mints nothing: it answers with the grant the
 * workspace's caller minted for the same refs. The relay asks for one the
 * way it asks any gateway.
 */
const delegatedClient = (id: string, url: string): GatewayClient => ({
  id,
  kinds: {},
  url: Effect.succeed(url),
  transport: "web",
  mint: (refs) => {
    const minted = delegated.get(delegatedKey(id, refs));
    return minted
      ? Effect.succeed(minted)
      : (Effect.fail(
          new DelegatedGrantMissing({
            message: `the workspace's caller granted nothing for ${canonicalJson(refs)}`,
            gateway: id,
          }),
        ) as never);
  },
});

/** Store `egress`'s grants, and the egress values `start` takes for them. */
const delegate = (egress: DelegatedEgress) => {
  for (const [gateway, refs] of byGateway(egress.refs)) {
    const minted = egress.minted[gateway];
    if (!minted) continue;
    delegated.set(delegatedKey(gateway, refs), minted);
    registerGatewayClient(delegatedClient(gateway, minted.gateway.url));
  }
  return egress.refs.map((ref) => ({ ref }) as never);
};

//#endregion

/** The container as the `SandboxClient` a volume's `Disk` runs blockd through. */
const asSandbox = (container: ContainerClient): SandboxClient =>
  ({
    exec: (cmd: ReadonlyArray<string>, options?: { readonly env?: Record<string, string> }) =>
      container.exec([...cmd], options as never).pipe(
        Effect.map((process): SandboxProcess => ({
          pid: process.pid,
          isPty: process.isPty,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          exitCode: process.exitCode.pipe(Effect.mapError(sandboxError)),
          output: () => process.output().pipe(Effect.mapError(sandboxError)),
          kill: (signal) => process.kill(signal).pipe(Effect.mapError(sandboxError)),
          resize: () => Effect.void,
        })),
        Effect.mapError(sandboxError),
      ),
  }) as unknown as SandboxClient;

const sandboxError = (cause: { readonly message: string }) =>
  new SandboxError({ message: cause.message, cause });

const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

//#region heads

/** A head record as `volume::store::Head` writes it, normalized for comparison. */
interface HeadRecord {
  readonly snapshot: string;
  readonly epoch: number;
  readonly seq: number;
  readonly pending: { readonly epoch: number; readonly seq: number } | null;
  readonly deleted: boolean;
}

const normalize = (value: unknown): HeadRecord | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return { snapshot: value, epoch: 0, seq: 0, pending: null, deleted: false };
  }
  const record = value as Partial<HeadRecord>;
  return {
    snapshot: record.snapshot!,
    epoch: record.epoch ?? 0,
    seq: record.seq ?? 0,
    pending: record.pending ? { epoch: record.pending.epoch, seq: record.pending.seq } : null,
    deleted: record.deleted ?? false,
  };
};

const sameRecord = (a: HeadRecord | null, b: HeadRecord | null) =>
  JSON.stringify(a) === JSON.stringify(b);

const encodeRecord = (record: HeadRecord) =>
  JSON.stringify({
    snapshot: record.snapshot,
    epoch: record.epoch,
    seq: record.seq,
    pending: record.pending,
    ...(record.deleted ? { deleted: true } : {}),
  });

const parseRecord = (text: string): HeadRecord | null => {
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return normalize(trimmed);
  try {
    return normalize(JSON.parse(trimmed));
  } catch {
    return null;
  }
};

//#endregion

/**
 * @internal The session Durable Object: the head of its session (cached,
 * written through to R2 with conditional writes, so R2 stays the store of
 * record), the leases of the `open`s running on it, and its commit log.
 *
 * Overlapping opens with the same grant share one mount; the last to
 * release snapshots it. A command forked from the session (placement
 * `serverless` or `automatic`) merges back here: its patch lands only if
 * nothing it changed was changed since its base, by a merge or by commands
 * on the mounted head. The log records both, by sequence number.
 */
const sessionImpl = (config: HostConfig) =>
  Effect.gen(function* () {
    const volume = yield* volumeOf(config.id);
    // Through this Worker's own script: the objects reference each other.
    const machines = yield* machineObject(config.id).from(thisWorker);
    const pools = yield* poolObject(config.id).from(thisWorker);
    // One pool per workspace.
    const pool = {
      claim: (session: string | undefined) => pools.getByName("pool").claim(session),
      release: (machine: string, session: string | undefined) =>
        pools.getByName("pool").release(machine, session),
      touch: (machine: string) => pools.getByName("pool").touch(machine),
    };
    const sessions = yield* sessionObject(config.id).from(thisWorker);
    const env = (yield* WorkerEnvironment) as Record<string, unknown> | undefined;
    const prefix = `volumes/${config.id}`;
    const bucket = () => env?.[volumeBucketBinding(config.id)] as cf.R2Bucket | undefined;
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const headLock = yield* Semaphore.make(1);
      const openLock = yield* Semaphore.make(1);
      // One merge at a time: each checks the log the one before it wrote.
      const commitLock = yield* Semaphore.make(1);
      let cached:
        | { readonly record: HeadRecord | null; readonly etag: string | undefined }
        | undefined;

      const r2 = <A>(what: string, run: (bucket: cf.R2Bucket) => Promise<A>) =>
        Effect.tryPromise({
          try: () => {
            const found = bucket();
            if (!found) throw new Error("the workspace's bucket isn't bound to its host");
            return run(found);
          },
          catch: (cause) => fail(`${what}: ${String(cause)}`, cause),
        });

      const readHead = Effect.fn(function* (session: string) {
        if (cached) return cached;
        const object = yield* r2("reading a head", (b) => b.get(`${prefix}/heads/${session}`));
        const record = object
          ? parseRecord(yield* r2("reading a head", () => object.text()))
          : null;
        cached = { record, etag: object?.etag };
        return cached;
      });

      /** Compare-and-set the head, through to R2. */
      const casHead = Effect.fn(function* (
        session: string,
        expected: HeadRecord | null,
        next: HeadRecord | null,
      ) {
        const current = yield* readHead(session);
        if (!sameRecord(current.record, expected))
          return { ok: false as const, found: current.record };
        const key = `${prefix}/heads/${session}`;
        if (next === null) {
          yield* r2("deleting a head", (b) => b.delete(key));
          cached = { record: null, etag: undefined };
          return { ok: true as const };
        }
        const written = yield* r2("writing a head", (b) =>
          b.put(key, encodeRecord(next), {
            onlyIf:
              current.etag === undefined
                ? ({ etagDoesNotMatch: "*" } as cf.R2Conditional)
                : { etagMatches: current.etag },
          }),
        );
        if (written === null) {
          // Someone wrote R2 behind this object's back: read it again.
          cached = undefined;
          return { ok: false as const, found: (yield* readHead(session)).record };
        }
        cached = { record: next, etag: written.etag };
        return { ok: true as const };
      });

      /** Journal entries this object keeps for blockd, by lease epoch and position. */
      const ENTRY = "workspace:journal:";
      const entryKey = (epoch: number, seq: number) =>
        `${ENTRY}${String(epoch).padStart(16, "0")}:${String(seq).padStart(16, "0")}`;
      /** Delete the entries the head no longer needs (volume's `journal_needed`). */
      const prune = Effect.fn(function* (record: HeadRecord | null) {
        const entries = yield* state.storage.list<Uint8Array>({ prefix: ENTRY });
        for (const key of entries.keys()) {
          const [epoch, seq] = key.slice(ENTRY.length).split(":").map(Number) as [number, number];
          const needed =
            record !== null &&
            !record.deleted &&
            (epoch > record.epoch ||
              (epoch === record.epoch && seq >= record.seq) ||
              (record.pending !== null &&
                epoch === record.pending.epoch &&
                seq >= record.pending.seq));
          if (!needed) yield* state.storage.delete(key);
        }
      });

      /** Heads changed through the R2 client (fork, undo, delete): drop the cache. */
      const viaVolume = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        headLock.withPermits(1)(
          Effect.ensuring(
            effect,
            Effect.sync(() => (cached = undefined)),
          ),
        );

      /** A session that doesn't exist yet starts from the base. */
      const ensureHead = Effect.fn(function* (session: string) {
        if (
          (yield* viaVolume(volume.head(session)).pipe(Effect.mapError(asWorkspaceError))) ===
          undefined
        ) {
          yield* viaVolume(volume.fork(session)).pipe(Effect.mapError(asWorkspaceError));
        }
      });

      //#region the commit log

      const LOG = "workspace:log:";
      const SEQ = "workspace:seq";
      /** The last logged change the head's snapshot holds. */
      const SNAPSHOT_SEQ = "workspace:snapshot-seq";
      /** Commands forked and not merged yet: call → the sequence of their base. */
      const CALLS = "workspace:calls";
      const logKey = (seq: number) => `${LOG}${String(seq).padStart(16, "0")}`;

      /** Log a change to the head: its paths, or `null` if nobody can name them. */
      const appendLog = Effect.fn(function* (paths: ChangedPaths) {
        const current = (yield* state.storage.get<number>(SEQ)) ?? 0;
        if (paths !== null && paths.length === 0) return current;
        const seq = current + 1;
        yield* state.storage.put(logKey(seq), { paths });
        yield* state.storage.put(SEQ, seq);
        return seq;
      });

      /** Every change logged after `seq`, but those numbered in `except`. */
      const logSince = Effect.fn(function* (seq: number, except: ReadonlyArray<number> = []) {
        const entries = yield* state.storage.list<{ readonly paths: ChangedPaths }>({
          prefix: LOG,
          start: logKey(seq + 1),
        });
        const skip = new Set(except.map(logKey));
        return [...entries.entries()]
          .filter(([key]) => !skip.has(key))
          .map(([, entry]) => entry.paths);
      });

      /** The head's snapshot now holds everything logged. */
      const markSnapshot = Effect.gen(function* () {
        yield* state.storage.put(SNAPSHOT_SEQ, (yield* state.storage.get<number>(SEQ)) ?? 0);
      });

      /** Drop entries no command still forked from could need. */
      const pruneLog = Effect.gen(function* () {
        const calls = (yield* state.storage.get<Record<string, number>>(CALLS)) ?? {};
        const oldest = Math.min(
          (yield* state.storage.get<number>(SNAPSHOT_SEQ)) ?? 0,
          ...Object.values(calls),
        );
        const stale = yield* state.storage.list({ prefix: LOG, end: logKey(oldest + 1) });
        for (const key of stale.keys()) yield* state.storage.delete(key);
      });

      const trackCall = (call: string, seq: number | undefined) =>
        Effect.gen(function* () {
          const calls = (yield* state.storage.get<Record<string, number>>(CALLS)) ?? {};
          const { [call]: _done, ...rest } = calls;
          yield* state.storage.put(CALLS, seq === undefined ? rest : { ...rest, [call]: seq });
        });

      /** A head moved some other way (undo, fork, delete): every base before it is stale. */
      const headReplaced = Effect.gen(function* () {
        yield* appendLog(null);
        yield* markSnapshot;
      });
      // (A process host is dropped first: see `dropHost`.)

      const deletePatch = (patch: string) =>
        r2("deleting a patch", (b) => b.delete(`${prefix}/${patch}`)).pipe(Effect.ignore);

      //#endregion

      //#region leases

      interface Opens {
        readonly leases: Record<string, number>; // lease → expiry (ms since epoch)
        readonly session?: string;
        readonly grant?: string;
        readonly machine?: string;
        readonly dir?: string;
      }
      const OPENS = "workspace:opens";
      const loadOpens = Effect.map(
        state.storage.get<Opens>(OPENS),
        (opens) => opens ?? { leases: {} },
      );
      const HOST_SYNC_AT = "workspace:host-sync-at";
      /** The next lease expiry, or the next commit of a process host, whichever is first. */
      const schedule = (opens: Opens) =>
        Effect.gen(function* () {
          const sync = yield* state.storage.get<number>(HOST_SYNC_AT);
          const times = [...Object.values(opens.leases), ...(sync !== undefined ? [sync] : [])];
          if (times.length > 0) yield* state.storage.setAlarm(Math.min(...times));
        });
      const saveOpens = (opens: Opens) =>
        Effect.gen(function* () {
          yield* state.storage.put(OPENS, opens);
          yield* schedule(opens);
        });

      /** Mount the session's head on a machine from the pool. */
      const mountHead = Effect.fn(function* (
        session: string,
        egress: DelegatedEgress | undefined,
        hostUrl: string | undefined,
      ) {
        yield* ensureHead(session);
        const machine = yield* pool.claim(session);
        const mounted = yield* Effect.exit(
          machines.getByName(machine).mount(session, config, egress, hostUrl),
        );
        if (mounted._tag === "Failure") {
          yield* pool.release(machine, session);
          return yield* Effect.failCause(mounted.cause);
        }
        return { machine, dir: mounted.value.dir };
      });

      /** Unmount if nothing holds the mount any more; returns what the unmount said. */
      const settle = Effect.fn(function* (session: string, opens: Opens) {
        if (Object.keys(opens.leases).length > 0 || !opens.machine) {
          yield* saveOpens(opens);
          return undefined;
        }
        const unmounted = yield* Effect.exit(machines.getByName(opens.machine).unmount(session));
        yield* saveOpens({ leases: {} });
        yield* pool.release(opens.machine, session);
        if (unmounted._tag === "Failure") {
          // The next mount recovers whatever the journal holds.
          yield* Effect.logWarning(`unmounting ${session} failed`, unmounted.cause);
          yield* headReplaced;
          return undefined;
        }
        yield* appendLog(unmounted.value.paths);
        yield* markSnapshot;
        return unmounted.value;
      });

      const dropExpired = (opens: Opens): Opens => {
        const now = Date.now();
        return {
          ...opens,
          leases: Object.fromEntries(Object.entries(opens.leases).filter(([, at]) => at > now)),
        };
      };

      /** Waits until `ready` holds under the lock, then runs `body` under it. */
      const whenReady = <A>(
        session: string,
        ready: (opens: Opens) => boolean,
        body: (opens: Opens) => Effect.Effect<A, WorkspaceError, RuntimeContext>,
      ) =>
        openLock
          .withPermits(1)(
            Effect.gen(function* () {
              const loaded = yield* loadOpens;
              const opens = dropExpired(loaded);
              if (Object.keys(opens.leases).length !== Object.keys(loaded.leases).length) {
                yield* settle(session, opens);
              }
              const current = dropExpired(yield* loadOpens);
              if (!ready(current)) return { waiting: true as const };
              return { waiting: false as const, value: yield* body(current) };
            }),
          )
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("250 millis"),
              until: (outcome) => !outcome.waiting,
            }),
            Effect.map((outcome) => (outcome as { readonly value: A }).value),
          );

      const idle = (opens: Opens) => Object.keys(opens.leases).length === 0;
      /** Only merges hold the mount: an open of any grant can take it over. */
      const merging = (opens: Opens) =>
        Object.keys(opens.leases).length === 1 && INTEGRATOR in opens.leases;

      const acquire = (
        session: string,
        grant: string,
        egress: DelegatedEgress | undefined,
        hostUrl: string | undefined,
      ) =>
        whenReady(
          session,
          (opens) => idle(opens) || opens.grant === grant || merging(opens),
          Effect.fn(function* (opens) {
            const lease = crypto.randomUUID();
            const expires = Date.now() + Duration.toMillis(LEASE_TTL);
            if (!idle(opens)) {
              if (opens.grant !== grant) {
                yield* machines.getByName(opens.machine!).grant(config, egress);
              }
              yield* saveOpens({ ...opens, grant, leases: { ...opens.leases, [lease]: expires } });
              return { lease, machine: opens.machine!, dir: opens.dir! };
            }
            const { machine, dir } = yield* mountHead(session, egress, hostUrl);
            yield* saveOpens({ leases: { [lease]: expires }, session, grant, machine, dir });
            return { lease, machine, dir };
          }),
        );

      const release = (session: string, lease: string) =>
        openLock.withPermits(1)(
          Effect.gen(function* () {
            const opens = yield* loadOpens;
            const { [lease]: _released, ...leases } = opens.leases;
            return yield* settle(session, { ...opens, leases });
          }),
        );

      /**
       * The session's head mounted for merges: the mount an open holds, or
       * one of its own that stays a moment for the next merge.
       */
      const holdForMerge = Effect.fn(function* (
        session: string,
        hostUrl: string | undefined,
        until: number,
      ) {
        return yield* openLock.withPermits(1)(
          Effect.gen(function* () {
            const opens = dropExpired(yield* loadOpens);
            if (opens.machine) {
              yield* saveOpens({ ...opens, leases: { ...opens.leases, [INTEGRATOR]: until } });
              return opens.machine;
            }
            const { machine, dir } = yield* mountHead(session, undefined, hostUrl);
            yield* saveOpens({
              leases: { [INTEGRATOR]: until },
              session,
              grant: "",
              machine,
              dir,
            });
            return machine;
          }),
        );
      });

      //#endregion

      //#region merging

      /** While a merge runs its mount can't expire; afterwards it stays a moment. */
      const LONG = Duration.toMillis(Duration.minutes(15));
      const linger = (session: string, hostUrl: string | undefined) =>
        holdForMerge(session, hostUrl, Date.now() + Duration.toMillis(INTEGRATOR_IDLE)).pipe(
          Effect.ignore,
        );

      /** A command's patch waiting to land, with whoever waits for the outcome. */
      interface Pending {
        readonly base: { readonly snapshot: Snapshot; readonly seq: number };
        readonly patch: string;
        readonly summary: PatchSummary;
        readonly call: string;
        readonly done: Deferred.Deferred<WorkspaceChanges, WorkspaceError>;
      }
      const queue: Array<Pending> = [];

      /**
       * Land every waiting patch on the head, in order: each is refused (and
       * kept as a fork) if it changed a path changed since its base, by the
       * head's own commands or an earlier patch. The rest are applied
       * together, under one snapshot (group commit).
       */
      const drain = Effect.fn(function* (session: string, hostUrl: string | undefined) {
        const batch = queue.splice(0);
        if (batch.length === 0) return;
        const landed = Effect.gen(function* () {
          const machine = machines.getByName(
            yield* holdForMerge(session, hostUrl, Date.now() + LONG),
          );
          // What the head's own commands changed counts as a change since every base.
          yield* appendLog(yield* machine.checkpoint(session));
          const accepted: Array<Pending> = [];
          const refused: Array<{
            readonly pending: Pending;
            readonly paths: ReadonlyArray<string>;
          }> = [];
          for (const pending of batch) {
            const clashes = conflicts(
              pending.summary.paths,
              yield* logSince(pending.base.seq),
              config.lww,
            );
            if (clashes.length > 0) {
              refused.push({ pending, paths: clashes });
              continue;
            }
            accepted.push(pending);
            yield* appendLog(pending.summary.paths);
          }
          if (accepted.length > 0) {
            yield* machine.apply(
              session,
              accepted.map((pending) => pending.patch),
            );
            const snapshot = yield* machine.snapshot(session);
            yield* markSnapshot;
            for (const pending of accepted) {
              yield* deletePatch(pending.patch);
              yield* Deferred.succeed(pending.done, {
                status: "applied",
                snapshot,
                paths: pending.summary.paths,
              });
            }
          }
          for (const { pending, paths } of refused) {
            const fork = conflictFork(session, pending.call);
            const adopted = yield* Effect.exit(
              sessions.getByName(fork).adopt(fork, pending.base.snapshot, pending.patch, hostUrl),
            );
            yield* Deferred.succeed(
              pending.done,
              adopted._tag === "Success"
                ? { status: "conflict", paths, fork }
                : { status: "conflict", paths },
            );
          }
        });
        const exit = yield* Effect.exit(landed);
        if (exit._tag === "Failure") {
          for (const pending of batch) {
            yield* Deferred.failCause(pending.done, exit.cause as never);
          }
        }
      });

      /** Land `patch` (a command's, from base `seq`), with any others waiting. */
      const commit = Effect.fn(function* (
        session: string,
        base: { readonly snapshot: Snapshot; readonly seq: number },
        patch: string,
        summary: PatchSummary,
        call: string,
        hostUrl: string | undefined,
      ) {
        const done = yield* Deferred.make<WorkspaceChanges, WorkspaceError>();
        queue.push({ base, patch, summary, call, done });
        yield* commitLock
          .withPermits(1)(drain(session, hostUrl))
          .pipe(Effect.ensuring(linger(session, hostUrl)));
        return yield* Deferred.await(done);
      });

      //#region process hosts

      /**
       * A command whose processes outlived it (placement `automatic`): its
       * fork stays mounted on its machine for them. The session's next
       * commands run there too, so they see what those processes see (their
       * files, their ports), and what changes there merges into the head
       * after each command and every few seconds.
       */
      interface Host {
        readonly session: string;
        readonly machine: string;
        readonly call: string;
        readonly base: { readonly snapshot: Snapshot; readonly seq: number };
        readonly hostUrl?: string;
        /** Its own commits' sequence numbers: they never conflict with it. */
        readonly own: ReadonlyArray<number>;
        /** Its changes stopped landing: these conflicted. Kept as a fork when it ends. */
        readonly diverged?: ReadonlyArray<string>;
      }
      const HOST = "workspace:host";
      const HOST_SYNC = Duration.toMillis(Duration.seconds(5));
      const forkOf = (host: Host) => conflictFork(host.session, host.call);
      const saveHost = (host: Host | undefined) =>
        Effect.gen(function* () {
          if (host) {
            yield* state.storage.put(HOST, host);
            yield* state.storage.put(HOST_SYNC_AT, Date.now() + HOST_SYNC);
          } else {
            yield* state.storage.delete(HOST);
            yield* state.storage.delete(HOST_SYNC_AT);
          }
          yield* schedule(yield* loadOpens);
        });

      /** Land one of a host's commits on the head, unless it conflicts. */
      const landHost = Effect.fn(function* (host: Host, reply: DiskHostCommit) {
        if (!reply.patch) {
          return { host, changes: { status: "applied", paths: [] } satisfies WorkspaceChanges };
        }
        if (host.diverged) {
          yield* deletePatch(reply.patch);
          const changes: WorkspaceChanges = {
            status: "conflict",
            paths: host.diverged,
            fork: forkOf(host),
          };
          return { host, changes };
        }
        const head = machines.getByName(
          yield* holdForMerge(host.session, host.hostUrl, Date.now() + LONG),
        );
        yield* appendLog(yield* head.checkpoint(host.session));
        const clashes = conflicts(
          reply.summary.paths,
          yield* logSince(host.base.seq, host.own),
          config.lww,
        );
        if (clashes.length > 0) {
          yield* deletePatch(reply.patch);
          const next = { ...host, diverged: clashes };
          yield* saveHost(next);
          const changes: WorkspaceChanges = {
            status: "conflict",
            paths: clashes,
            fork: forkOf(host),
          };
          return { host: next, changes };
        }
        yield* head.apply(host.session, [reply.patch]);
        const seq = yield* appendLog(reply.summary.paths);
        const snapshot = yield* head.snapshot(host.session);
        yield* markSnapshot;
        yield* deletePatch(reply.patch);
        const next = { ...host, own: [...host.own, seq] };
        yield* saveHost(next);
        const changes: WorkspaceChanges = {
          status: "applied",
          snapshot,
          paths: reply.summary.paths,
        };
        return { host: next, changes };
      });

      /** The host's processes are done (or it's dropped): the last of its changes, and its machine back. */
      const endHost = Effect.fn(function* (host: Host, keep: boolean) {
        const machine = machines.getByName(host.machine);
        const key = `patches/${host.session}/${host.call}-last-${Date.now()}`;
        let changes: WorkspaceChanges = { status: "applied", paths: [] };
        if (keep && host.diverged) {
          // Everything it changed since its fork, kept as a session of its own.
          const full = yield* machine.hostCommit(`${key}-full`, true);
          const detached = yield* machine.hostDetach(key);
          if (detached.patch) yield* deletePatch(detached.patch);
          if (full.patch) {
            yield* sessions
              .getByName(forkOf(host))
              .adopt(forkOf(host), host.base.snapshot, full.patch, host.hostUrl);
          }
          changes = { status: "conflict", paths: host.diverged, fork: forkOf(host) };
        } else {
          const detached = yield* machine.hostDetach(key);
          if (keep) changes = (yield* landHost(host, detached)).changes;
          else if (detached.patch) yield* deletePatch(detached.patch);
        }
        yield* saveHost(undefined);
        yield* trackCall(host.call, undefined);
        yield* pool.release(host.machine, host.session);
        return changes;
      });

      /** Commit what changed on the host since its last commit; end it if its processes are done. */
      const syncHost = Effect.fn(function* () {
        const host = yield* state.storage.get<Host>(HOST);
        if (!host) return undefined;
        yield* pool.touch(host.machine);
        const key = `patches/${host.session}/${host.call}-${Date.now()}`;
        const reply = yield* machines.getByName(host.machine).hostCommit(key, false);
        const landed = yield* landHost(host, reply);
        if (reply.survivors.length > 0) return landed.changes;
        const last = yield* endHost(landed.host, true);
        return last.paths.length > 0 || last.status === "conflict" ? last : landed.changes;
      });

      /** A command on the session's process host. */
      const runOnHost = Effect.fn(function* (host: Host, command: string, options: RunOptions) {
        const output = yield* machines.getByName(host.machine).exec(command, {
          cwd: options.cwd ?? config.path,
          ...(options.env ? { env: options.env } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        const changes: WorkspaceChanges = (yield* commitLock
          .withPermits(1)(syncHost())
          .pipe(Effect.ensuring(linger(host.session, host.hostUrl)))) ?? {
          status: "applied",
          paths: [],
        };
        return { ...output, changes } satisfies WorkspaceExecResult;
      });

      /** Stop a host without keeping what it changed (the head moved some other way). */
      const dropHost = Effect.gen(function* () {
        const host = yield* state.storage.get<Host>(HOST);
        if (host) yield* Effect.ignore(endHost(host, false));
      });

      //#endregion

      /** A command on a fork of the session, on any machine, merged back. */
      const runForked = Effect.fn(function* (
        session: string,
        command: string,
        options: RunOptions,
        egress: DelegatedEgress | undefined,
        hostUrl: string | undefined,
      ) {
        if (config.placement === "automatic") {
          const host = yield* state.storage.get<Host>(HOST);
          if (host) return yield* runOnHost(host, command, options);
        }
        const keep = config.placement === "automatic";
        const call = crypto.randomUUID();
        const base = yield* openLock.withPermits(1)(
          Effect.gen(function* () {
            yield* ensureHead(session);
            const { record } = yield* headLock.withPermits(1)(readHead(session));
            if (!record) return yield* fail(`${session} has no head`);
            const seq = (yield* state.storage.get<number>(SNAPSHOT_SEQ)) ?? 0;
            yield* trackCall(call, seq);
            return { snapshot: record.snapshot, seq };
          }),
        );
        const patch = `patches/${session}/${call}`;
        let kept = false;
        return yield* Effect.gen(function* () {
          const machine = yield* pool.claim(session);
          const ran = yield* machines
            .getByName(machine)
            .call(
              base.snapshot,
              command,
              { ...options, patch, ...(keep ? { keep } : {}) },
              config,
              egress,
            )
            .pipe(Effect.onError(() => pool.release(machine, session)));
          if (ran.kept) {
            // Its processes keep the machine: the session's commands go there now.
            kept = true;
            const host: Host = {
              session,
              machine,
              call,
              base,
              own: [],
              ...(hostUrl ? { hostUrl } : {}),
            };
            yield* saveHost(host);
            const changes = (yield* commitLock
              .withPermits(1)(
                landHost(host, {
                  ...(ran.patch ? { patch: ran.patch } : {}),
                  summary: ran.summary,
                  survivors: ran.survivors,
                }),
              )
              .pipe(Effect.ensuring(linger(session, hostUrl)))).changes;
            return {
              exitCode: ran.exitCode,
              stdout: ran.stdout,
              stderr: ran.stderr,
              changes,
            } satisfies WorkspaceExecResult;
          }
          yield* pool.release(machine, session);
          const changes: WorkspaceChanges = ran.patch
            ? yield* commit(session, base, ran.patch, ran.summary, call, hostUrl)
            : { status: "applied", paths: [] };
          return {
            exitCode: ran.exitCode,
            stdout: ran.stdout,
            stderr: ran.stderr,
            changes,
            ...(ran.survivors.length > 0 ? { stopped: ran.survivors } : {}),
          } satisfies WorkspaceExecResult;
        }).pipe(
          Effect.onError(() => deletePatch(patch)),
          // A host's base stays tracked until it ends.
          Effect.ensuring(
            Effect.suspend(() =>
              kept ? Effect.void : Effect.andThen(trackCall(call, undefined), pruneLog),
            ).pipe(Effect.ignore),
          ),
        );
      });

      //#endregion

      return {
        journal: (
          session: string,
          request: {
            readonly method: "GET" | "POST" | "DELETE";
            readonly epoch: number;
            readonly seq: number;
            readonly to?: number;
            readonly body?: Uint8Array;
          },
        ) =>
          headLock
            .withPermits(1)(
              Effect.gen(function* () {
                const key = entryKey(request.epoch, request.seq);
                if (request.method === "GET") {
                  const entry = yield* state.storage.get<Uint8Array>(key);
                  return entry ? { status: 200, body: entry } : { status: 404 };
                }
                if (request.method === "DELETE") {
                  for (let seq = request.seq; seq < (request.to ?? request.seq); seq++) {
                    yield* state.storage.delete(entryKey(request.epoch, seq));
                  }
                  return { status: 200 };
                }
                const body = request.body ?? new Uint8Array();
                const existing = yield* state.storage.get<Uint8Array>(key);
                if (existing) {
                  return { status: sameBytes(existing, body) ? 208 : 409 };
                }
                // The fence: only the lease that holds the head appends.
                const { record } = yield* readHead(session);
                if (!record || record.deleted || record.epoch !== request.epoch) {
                  return { status: 409 };
                }
                yield* state.storage.put(key, body);
                return { status: 200 };
              }),
            )
            .pipe(Effect.catch(() => Effect.succeed({ status: 503 }))),

        heads: (session: string, method: "GET" | "POST", body: string) =>
          headLock
            .withPermits(1)(
              Effect.gen(function* () {
                if (method === "GET") {
                  const { record } = yield* readHead(session);
                  return record
                    ? { status: 200, body: encodeRecord(record) }
                    : { status: 404, body: "{}" };
                }
                const request = JSON.parse(body) as { expected: unknown; new: unknown };
                const result = yield* casHead(
                  session,
                  normalize(request.expected),
                  normalize(request.new),
                );
                if (result.ok) yield* prune(normalize(request.new));
                return result.ok
                  ? { status: 200, body: "{}" }
                  : {
                      status: 409,
                      body: JSON.stringify({
                        found: result.found ? JSON.parse(encodeRecord(result.found)) : null,
                      }),
                    };
              }),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.succeed({ status: 503, body: JSON.stringify({ error: error.message }) }),
              ),
            ),

        acquire,

        renew: (session: string, lease: string, egress: DelegatedEgress | undefined) =>
          openLock.withPermits(1)(
            Effect.gen(function* () {
              const opens = yield* loadOpens;
              if (!(lease in opens.leases)) {
                return yield* fail(`the lease on ${session} expired`);
              }
              if (opens.machine) {
                if (egress) yield* machines.getByName(opens.machine).refresh(egress);
                yield* pool.touch(opens.machine);
              }
              yield* saveOpens({
                ...opens,
                leases: { ...opens.leases, [lease]: Date.now() + Duration.toMillis(LEASE_TTL) },
              });
            }),
          ),

        release: (session: string, lease: string) => Effect.asVoid(release(session, lease)),

        run: (
          session: string,
          command: string,
          options: RunOptions,
          grant: string,
          egress: DelegatedEgress | undefined,
          hostUrl: string | undefined,
        ) =>
          config.placement === "pinned"
            ? Effect.gen(function* () {
                // Released before it returns: an open's last release snapshots.
                let released:
                  | { readonly snapshot: Snapshot | undefined; readonly paths: ChangedPaths }
                  | undefined;
                const lease = yield* acquire(session, grant, egress, hostUrl);
                const output = yield* machines
                  .getByName(lease.machine)
                  .exec(command, {
                    cwd: options.cwd ?? lease.dir,
                    ...(options.env ? { env: options.env } : {}),
                    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                  })
                  .pipe(
                    Effect.onExit(() =>
                      release(session, lease.lease).pipe(
                        Effect.tap((value) => Effect.sync(() => (released = value))),
                        Effect.ignore,
                      ),
                    ),
                  );
                return {
                  ...output,
                  changes: {
                    status: "applied",
                    ...(released?.snapshot ? { snapshot: released.snapshot } : {}),
                    paths: released?.paths ?? [],
                  },
                } satisfies WorkspaceExecResult;
              })
            : runForked(session, command, options, egress, hostUrl),

        merge: (session: string, from: string, hostUrl: string | undefined) =>
          commitLock.withPermits(1)(
            Effect.gen(function* () {
              const ours = yield* volume.history(session, { limit: 500 });
              const theirs = yield* volume.history(from, { limit: 500 });
              const known = new Set(ours);
              const ancestor = theirs.find((snapshot) => known.has(snapshot));
              // Where the last merge from `from` left both sides, if they still descend from it.
              const MERGED = `workspace:merged:${from}`;
              const last = yield* state.storage.get<{
                readonly from: Snapshot;
                readonly into: Snapshot;
              }>(MERGED);
              const since =
                last && theirs.includes(last.from) && ours.includes(last.into)
                  ? last
                  : ancestor !== undefined
                    ? { from: ancestor, into: ancestor }
                    : undefined;
              if (since === undefined) {
                return yield* fail(`${from} and ${session} share no snapshot to merge from`);
              }
              if (theirs[0] === since.from) {
                return { status: "applied", paths: [] } satisfies WorkspaceChanges;
              }
              const head = machines.getByName(
                yield* holdForMerge(session, hostUrl, Date.now() + LONG),
              );
              yield* appendLog(yield* head.checkpoint(session));
              const now = yield* head.snapshot(session);
              yield* markSnapshot;
              const patch = `patches/${session}/merge-${crypto.randomUUID()}`;
              const worker = yield* pool.claim(undefined);
              const [incoming, local] = yield* Effect.all(
                [
                  machines.getByName(worker).diff(since.from, theirs[0]!, patch, config),
                  machines.getByName(worker).diff(since.into, now, undefined, config),
                ],
                { concurrency: 1 },
              ).pipe(Effect.ensuring(pool.release(worker, undefined)));
              const clashes = conflicts(incoming.summary.paths, [local.summary.paths], config.lww);
              if (clashes.length > 0 || !incoming.patch) {
                yield* deletePatch(patch);
                return clashes.length > 0
                  ? ({ status: "conflict", paths: clashes } satisfies WorkspaceChanges)
                  : ({ status: "applied", paths: [] } satisfies WorkspaceChanges);
              }
              yield* head.apply(session, [incoming.patch]);
              yield* appendLog(incoming.summary.paths);
              const snapshot = yield* head.snapshot(session);
              yield* markSnapshot;
              yield* deletePatch(patch);
              yield* state.storage.put(MERGED, { from: theirs[0]!, into: snapshot });
              return {
                status: "applied",
                snapshot,
                paths: incoming.summary.paths,
              } satisfies WorkspaceChanges;
            }).pipe(Effect.mapError(asWorkspaceError), Effect.ensuring(linger(session, hostUrl))),
          ),

        adopt: (session: string, snapshot: Snapshot, patch: string, hostUrl: string | undefined) =>
          commitLock.withPermits(1)(
            Effect.gen(function* () {
              yield* whenReady(session, idle, () =>
                Effect.gen(function* () {
                  if ((yield* viaVolume(volume.head(session))) === undefined) {
                    yield* viaVolume(volume.fork(session));
                  }
                  yield* viaVolume(volume.reset(session, snapshot));
                  yield* headReplaced;
                }).pipe(Effect.mapError(asWorkspaceError)),
              );
              const head = machines.getByName(
                yield* holdForMerge(session, hostUrl, Date.now() + LONG),
              );
              const applied = yield* head.apply(session, [patch]);
              yield* appendLog(applied.applied.flatMap((summary) => summary.paths));
              yield* head.snapshot(session);
              yield* markSnapshot;
              yield* deletePatch(patch);
            }).pipe(Effect.ensuring(linger(session, hostUrl))),
          ),

        fork: (session: string, from: string) =>
          whenReady(session, idle, () =>
            Effect.andThen(
              commitLock.withPermits(1)(dropHost),
              viaVolume(volume.fork(session, { from })),
            ).pipe(Effect.asVoid, Effect.andThen(headReplaced), Effect.mapError(asWorkspaceError)),
          ),

        undo: (session: string, steps: number) =>
          whenReady(session, idle, () =>
            Effect.gen(function* () {
              const history = yield* volume.history(session, { limit: steps + 1 });
              const target = history[steps];
              if (target === undefined) {
                return yield* fail(`${session} has fewer than ${steps} snapshots to undo`);
              }
              yield* commitLock.withPermits(1)(dropHost);
              yield* viaVolume(volume.reset(session, target));
              yield* headReplaced;
            }).pipe(Effect.mapError(asWorkspaceError)),
          ),

        history: (session: string, limit: number) =>
          volume.history(session, { limit }).pipe(Effect.mapError(asWorkspaceError)),

        remove: (session: string) =>
          whenReady(session, idle, () =>
            Effect.andThen(
              commitLock.withPermits(1)(dropHost),
              viaVolume(volume.drop(session)),
            ).pipe(Effect.andThen(headReplaced), Effect.mapError(asWorkspaceError)),
          ),

        alarm: () =>
          Effect.gen(function* () {
            // A process host's changes, every few seconds.
            const syncAt = yield* state.storage.get<number>(HOST_SYNC_AT);
            if (syncAt !== undefined && syncAt <= Date.now()) {
              const host = yield* state.storage.get<Host>(HOST);
              yield* commitLock
                .withPermits(1)(syncHost())
                .pipe(
                  Effect.ensuring(host ? linger(host.session, host.hostUrl) : Effect.void),
                  Effect.catch((error) =>
                    Effect.logWarning("committing a process host failed", error),
                  ),
                );
              if (yield* state.storage.get<Host>(HOST)) {
                yield* state.storage.put(HOST_SYNC_AT, Date.now() + HOST_SYNC);
              }
            }
            yield* openLock
              .withPermits(1)(
                Effect.gen(function* () {
                  const opens = yield* loadOpens;
                  const live = dropExpired(opens);
                  if (Object.keys(live.leases).length === Object.keys(opens.leases).length) {
                    return yield* saveOpens(opens);
                  }
                  if (live.session) yield* settle(live.session, live);
                }),
              )
              .pipe(Effect.catch((error) => Effect.logWarning("expiring leases failed", error)));
          }),
      };
    });
  });

/** The Worker this runs in, for `.from`: its objects reference each other. */
const thisWorker = Effect.suspend(() => Worker) as unknown as Effect.Effect<never, never, Worker>;

const asWorkspaceError = (error: { readonly message: string }) =>
  error instanceof WorkspaceError ? error : fail(error.message, error);

/**
 * What a machine runs on. A Cloudflare container answers its blockd's head
 * and journal requests through a container control (the session's Durable
 * Object holds both); a sandbox elsewhere (a Lambda MicroVM) has no control
 * host, so its blockd reads and writes them in the store.
 */
interface MachineBackend {
  readonly disk: Disk;
  /** Run an argument vector and wait for it. */
  readonly run: (
    cmd: Array<string>,
    options: { readonly cwd?: string; readonly env?: Record<string, string> },
  ) => Effect.Effect<
    { readonly exitCode: number; readonly stdout: ArrayBuffer; readonly stderr: ArrayBuffer },
    { readonly message: string },
    RuntimeContext
  >;
  /** Start (or re-grant) the machine for an open. */
  readonly start: (
    config: HostConfig,
    egress: ReadonlyArray<never>,
    ttlMs: number | undefined,
  ) => Effect.Effect<void, { readonly message: string }, RuntimeContext>;
  /** An HTTP request to a port on the machine. */
  readonly port: (
    port: number,
    request: HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, RuntimeContext>;
  /** Whether blockd reaches the session through a container control. */
  readonly controls: boolean;
  /** Stop the machine (it's idle). */
  readonly stop: Effect.Effect<void, unknown, RuntimeContext>;
  /** Stop it for good: its disk goes with it. */
  readonly retire: Effect.Effect<void, { readonly message: string }, RuntimeContext>;
}

/** A Cloudflare container built from the workspace's Dockerfile. */
const containerBackend = (config: HostConfig, dockerfile?: string) =>
  Effect.gen(function* () {
    const Box = machineContainer(config.id, dockerfile);
    const container = yield* Box;
    const disk: Disk = yield* volumeOf(config.id).on(
      Object.assign(Effect.succeed(asSandbox(container)), {
        Application: (Box as unknown as { Application: Effect.Effect<unknown> }).Application,
      }) as never,
    );
    return {
      disk,
      run: (cmd, options) =>
        container.exec(cmd, options as never).pipe(
          Effect.flatMap((process) => process.output()),
          Effect.scoped,
        ),
      start: (hostConfig, egress, ttlMs) =>
        Effect.gen(function* () {
          yield* container.start({
            instance: hostConfig.instanceType,
            enableInternet: true,
            egress,
            ...(ttlMs !== undefined ? { ttl: ttlMs } : {}),
          });
          yield* container.setInactivityTimeout(hostConfig.idleMs);
        }),
      port: (port, request) =>
        Effect.flatMap(container.getTcpPort(port), (tcp) => tcp.fetch(request)),
      controls: true,
      // The container's inactivity timeout stops it.
      stop: Effect.void,
      retire: container.destroy(),
    } satisfies MachineBackend;
  });

/** A sandbox hosted elsewhere: a Lambda MicroVM (`machine.lambda`). */
const sandboxBackend = (config: HostConfig) =>
  Effect.gen(function* () {
    const Vm = machineSandbox(config.id);
    const sandbox = yield* Vm;
    const disk: Disk = yield* volumeOf(config.id).on(Vm);
    return {
      disk,
      run: (cmd, options) =>
        sandbox.exec(cmd, options).pipe(
          Effect.flatMap((process) => process.output()),
          Effect.scoped,
        ),
      start: (_hostConfig, egress, ttlMs) =>
        sandbox.start({
          size: "machine",
          enableInternet: true,
          egress,
          ...(ttlMs !== undefined ? { ttl: ttlMs } : {}),
        }),
      port: (port, request) =>
        Effect.gen(function* () {
          const client = yield* sandbox.httpClient(port);
          const response = yield* client.execute(HttpServerRequestModule.toClientRequest(request));
          return HttpServerResponse.stream(response.stream, {
            status: response.status,
            headers: response.headers,
          });
        }),
      controls: false,
      stop: sandbox.stop(),
      retire: sandbox.stop(),
    } satisfies MachineBackend;
  });

/**
 * A blockd's head or journal request (`volume::store::HttpMetaStore`,
 * `HttpJournalStore`), answered by the session's Durable Object: from a
 * container through its control host, or from a MicroVM through the host
 * Worker's own URL.
 */
const serveHeads = (
  sessions: DurableObjectNamespace<SessionShape>,
  request: Request,
): Effect.Effect<Response, never, RuntimeContext> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/journal/")) {
      const [session, epoch, seq] = url.pathname
        .slice("/journal/".length)
        .split("/")
        .map(decodeURIComponent) as [string, string, string | undefined];
      const method =
        request.method === "POST" ? "POST" : request.method === "DELETE" ? "DELETE" : "GET";
      const reply = yield* sessions.getByName(session).journal(session, {
        method,
        epoch: Number(epoch),
        seq: Number(seq ?? url.searchParams.get("from") ?? 0),
        ...(method === "DELETE" ? { to: Number(url.searchParams.get("to") ?? 0) } : {}),
        ...(method === "POST"
          ? {
              body: new Uint8Array(yield* Effect.promise(() => request.arrayBuffer())),
            }
          : {}),
      });
      return new Response((reply.body as BodyInit | undefined) ?? null, {
        status: reply.status,
      });
    }
    const session = decodeURIComponent(url.pathname.replace(/^\/heads\/?/, ""));
    if (!session) return new Response("[]", { status: 200 });
    const method = request.method === "POST" ? "POST" : "GET";
    const body = method === "POST" ? yield* Effect.promise(() => request.text()) : "";
    const reply = yield* sessions.getByName(session).heads(session, method, body);
    return new Response(reply.body, {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed(new Response(String(cause), { status: 503 }))),
  );

/**
 * @internal The pool: machines shared by every session of the workspace.
 * A claim takes a free machine, preferring the one the session used last
 * (its cache holds the session's blocks), then the most recently used;
 * a new one while there are fewer than `max`; otherwise it waits. A machine
 * retires after `retireAfter` sessions, and `min` free machines are kept
 * started.
 */
const poolImpl = (config: HostConfig) =>
  Effect.gen(function* () {
    const machines = yield* machineObject(config.id).from(thisWorker);
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const lock = yield* Semaphore.make(1);
      interface Slot {
        readonly busy: boolean;
        readonly uses: number;
        readonly last?: string;
        /** When it was last claimed, released or touched. */
        readonly at: number;
      }
      interface Pool {
        readonly slots: Record<string, Slot>;
        readonly next: number;
      }
      const KEY = "workspace:pool";
      /** A machine claimed and never released or touched for this long is free. */
      const STALE = Duration.toMillis(Duration.minutes(30));
      const load = Effect.map(
        state.storage.get<Pool>(KEY),
        (pool) => pool ?? { slots: {}, next: 0 },
      );
      const save = (pool: Pool) => state.storage.put(KEY, pool);
      const free = (slot: Slot) => !slot.busy || Date.now() - slot.at > STALE;
      const warmEvery = Math.min(config.idleMs / 2, Duration.toMillis(Duration.minutes(1)));

      const tryClaim = (session: string | undefined) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const pool = yield* load;
            const candidates = Object.entries(pool.slots)
              .filter(([, slot]) => free(slot))
              .sort(([, a], [, b]) => b.at - a.at);
            let name =
              (session !== undefined
                ? candidates.find(([, slot]) => slot.last === session)?.[0]
                : undefined) ?? candidates[0]?.[0];
            let next = pool.next;
            if (name === undefined) {
              if (Object.keys(pool.slots).length >= config.pool.max) return undefined;
              name = `m${next++}`;
            }
            const slot = pool.slots[name];
            yield* save({
              next,
              slots: {
                ...pool.slots,
                [name]: { ...slot, uses: slot?.uses ?? 0, busy: true, at: Date.now() },
              },
            });
            if (config.pool.min > 0 && (yield* state.storage.getAlarm()) === null) {
              yield* state.storage.setAlarm(Date.now() + warmEvery);
            }
            return name;
          }),
        );

      return {
        claim: (session: string | undefined) =>
          tryClaim(session).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("250 millis"),
              until: (name) => name !== undefined,
            }),
            Effect.map((name) => name!),
            Effect.timeoutOrElse({
              duration: Duration.minutes(10),
              orElse: () => Effect.fail(fail(`every machine of ${config.id} stayed busy`)),
            }),
          ),

        release: (machine: string, session: string | undefined) =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                const pool = yield* load;
                const slot = pool.slots[machine];
                if (!slot) return;
                const uses = slot.uses + 1;
                if (uses >= config.pool.retireAfter) {
                  const { [machine]: _retired, ...slots } = pool.slots;
                  yield* save({ ...pool, slots });
                  yield* state.waitUntil(Effect.ignore(machines.getByName(machine).retire()));
                  return;
                }
                yield* save({
                  ...pool,
                  slots: {
                    ...pool.slots,
                    [machine]: {
                      busy: false,
                      uses,
                      at: Date.now(),
                      ...(session ? { last: session } : slot.last ? { last: slot.last } : {}),
                    },
                  },
                });
              }),
            )
            .pipe(
              Effect.catchCause((cause) => Effect.logWarning("releasing a machine failed", cause)),
            ),

        touch: (machine: string) =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                const pool = yield* load;
                const slot = pool.slots[machine];
                if (slot) {
                  yield* save({
                    ...pool,
                    slots: { ...pool.slots, [machine]: { ...slot, at: Date.now() } },
                  });
                }
              }),
            )
            .pipe(Effect.ignore),

        /** Keep `min` free machines started. */
        alarm: () =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                if (config.pool.min <= 0) return;
                const pool = yield* load;
                const idle = Object.entries(pool.slots)
                  .filter(([, slot]) => !slot.busy)
                  .sort(([, a], [, b]) => b.at - a.at)
                  .map(([name]) => name);
                let next = pool.next;
                const slots = { ...pool.slots };
                while (
                  idle.length < config.pool.min &&
                  Object.keys(slots).length < config.pool.max
                ) {
                  const name = `m${next++}`;
                  slots[name] = { busy: false, uses: 0, at: Date.now() };
                  idle.push(name);
                }
                yield* save({ slots, next });
                for (const name of idle.slice(0, config.pool.min)) {
                  yield* state.waitUntil(Effect.ignore(machines.getByName(name).warm(config)));
                }
                yield* state.storage.setAlarm(Date.now() + warmEvery);
              }),
            )
            .pipe(
              Effect.catchCause((cause) => Effect.logWarning("warming the pool failed", cause)),
            ),
      };
    });
  });

/**
 * @internal A machine: one container or MicroVM with blockd, serving one
 * session's mount or one forked command at a time, for any session of the
 * workspace (the pool hands it out). A container's blockd reads and moves
 * its head and appends its journal through the session's Durable Object.
 */
const machineImpl = (config: HostConfig, dockerfile?: string) =>
  Effect.gen(function* () {
    const backend: MachineBackend = yield* config.machine === "lambda"
      ? sandboxBackend(config)
      : containerBackend(config, dockerfile);
    const { disk, run } = backend;
    const sessions = yield* sessionObject(config.id).from(thisWorker);
    const env = (yield* WorkerEnvironment) as Record<string, unknown> | undefined;
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      let mounted: DiskMount | undefined;

      if (backend.controls) {
        registerControl(state.raw, {
          key: "alchemy:workspace-heads",
          host: HEADS_HOST,
          handle: (request) => serveHeads(sessions, request),
        });
      }

      /** Kill a blockd that won't detach, and whatever it left attached. */
      const forceDetach = (session: string) =>
        run(
          [
            "sh",
            "-c",
            [
              `pkill -9 -f "blockd mount .*--head ${session} " || true`,
              `umount -l ${config.path} 2>/dev/null || true`,
              `umount -l ${CACHE.replace(/\.cache$/, ".top")} 2>/dev/null || true`,
              `umount -l ${CACHE.replace(/\.cache$/, ".disk")} 2>/dev/null || true`,
              "losetup -D 2>/dev/null || true",
              `rm -f /run/blockd/${session}.sock`,
            ].join("; "),
          ],
          {},
        ).pipe(Effect.ignore);

      /**
       * What one session or command left behind, gone before the next: the
       * processes `spawn` started, and scratch space.
       */
      const wipe = run(
        [
          "sh",
          "-c",
          [
            'for f in /run/workspace/*/pid; do [ -f "$f" ] && kill -9 -- "-$(cat "$f")" 2>/dev/null; done',
            "rm -rf /run/workspace /tmp/* /tmp/.[!.]* /var/tmp/* 2>/dev/null",
            "true",
          ].join("; "),
        ],
        {},
      ).pipe(Effect.ignore);

      /**
       * Unmount `session`; returns its snapshot and what it changed since
       * its last checkpoint. A detach that fails (blockd died, say) is
       * cleaned up by force: its journal is still durable, and the next
       * mount's lease folds it.
       */
      const detach = Effect.fn(function* (session: string) {
        const current = mounted?.head === session ? mounted : undefined;
        mounted = undefined;
        const detached = current
          ? yield* Effect.exit(current.release)
          : // This object restarted while the machine kept the mount.
            yield* Effect.exit(
              run(
                [
                  "sh",
                  "-c",
                  `[ -S /run/blockd/${session}.sock ] && blockd control --socket /run/blockd/${session}.sock --request '{"op":"detach"}' || true`,
                ],
                {},
              ).pipe(
                Effect.map((reply) => {
                  const text = decode(reply.stdout);
                  return {
                    snapshot: /"snapshot":"([0-9a-f]+)"/.exec(text)?.[1] as Snapshot,
                    // An object that lost its mount can't say what changed.
                    paths: null as ChangedPaths,
                  };
                }),
              ),
            );
        if (detached._tag === "Success") return detached.value;
        yield* Effect.logWarning(
          `detaching ${session} failed; cleaning up by force`,
          detached.cause,
        );
        yield* forceDetach(session);
        return { snapshot: undefined, paths: null as ChangedPaths };
      });

      /** The session mounted here, or a failure saying it isn't. */
      const mountOf = (session: string) =>
        mounted?.head === session
          ? Effect.succeed(mounted)
          : Effect.fail(fail(`${session} isn't mounted on this machine`));

      const IDLE_AT = "workspace:idle-at";
      /** The control socket of a call whose processes this machine keeps. */
      const HOST = "workspace:host";
      /** A kept call left over (its session moved on): stop it, keep nothing. */
      const detachHost = Effect.gen(function* () {
        const socket = yield* state.storage.get<string>(HOST);
        if (!socket) return;
        yield* Effect.ignore(disk.host(socket).detach());
        yield* state.storage.delete(HOST);
      });
      /** A machine that bills while it runs stops once it's been idle. */
      const idleFromNow = Effect.gen(function* () {
        yield* state.storage.put(IDLE_AT, Date.now() + config.idleMs);
        yield* state.storage.setAlarm(Date.now() + config.idleMs);
      });

      return {
        mount: (
          session: string,
          hostConfig: HostConfig,
          egress: DelegatedEgress | undefined,
          hostUrl: string | undefined,
        ) =>
          Effect.gen(function* () {
            // Sessions only ask for a mount when they hold none: anything
            // mounted here is stale.
            if (mounted) yield* detach(mounted.head);
            yield* detachHost;
            yield* state.storage.delete(IDLE_AT);
            // The open's grant replaces whatever the last one granted.
            yield* backend.start(hostConfig, egress ? delegate(egress) : [], egress?.ttlMs);
            // A container reaches its session through a control host; a
            // machine elsewhere through the host Worker's URL, with its secret.
            const token = env?.[HOST_TOKEN];
            const base = backend.controls
              ? `http://${HEADS_HOST}`
              : hostUrl && typeof token === "string"
                ? hostUrl.replace(/\/$/, "")
                : undefined;
            mounted = yield* disk.mount(session, {
              dir: hostConfig.path,
              cache: CACHE,
              ...(base ? { heads: `${base}/heads`, journal: `${base}/journal` } : {}),
              ...(!backend.controls && base ? { env: { BLOCKD_HEADS_TOKEN: String(token) } } : {}),
            });
            return { dir: mounted.dir };
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        exec: (
          command: string,
          options: {
            readonly cwd: string;
            readonly env?: Record<string, string>;
            readonly timeoutMs?: number;
          },
        ) =>
          run(["sh", "-c", command], {
            cwd: options.cwd,
            ...(options.env ? { env: options.env } : {}),
          }).pipe(
            Effect.map((output) => ({
              exitCode: output.exitCode,
              stdout: decode(output.stdout),
              stderr: decode(output.stderr),
            })),
            options.timeoutMs === undefined
              ? (effect) => effect
              : Effect.timeoutOrElse({
                  duration: Duration.millis(options.timeoutMs),
                  orElse: () => Effect.fail(fail(`${command} timed out`)),
                }),
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        spawn: (
          command: string,
          options: { readonly cwd: string; readonly env?: Record<string, string> },
        ) =>
          Effect.gen(function* () {
            const id = crypto.randomUUID();
            const dir = `/run/workspace/${id}`;
            const script = [
              `mkdir -p ${dir}`,
              // Its own session, so killing it kills everything it started.
              `setsid sh -c 'sh -c "$WORKSPACE_COMMAND"; echo $? > ${dir}/code' > ${dir}/out 2> ${dir}/err < /dev/null &`,
              `echo $! > ${dir}/pid`,
              `cat ${dir}/pid`,
            ].join("\n");
            const output = yield* run(["sh", "-c", script], {
              cwd: options.cwd,
              env: { ...options.env, WORKSPACE_COMMAND: command },
            });
            return { id, pid: Number(decode(output.stdout).trim()) };
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        read: (id: string, stream: "out" | "err", offset: number) =>
          Effect.gen(function* () {
            const dir = `/run/workspace/${id.replace(/[^0-9a-f-]/g, "")}`;
            const code = yield* run(["sh", "-c", `cat ${dir}/code 2>/dev/null || true`], {});
            const data = yield* run(
              ["sh", "-c", `tail -c +${Math.max(0, Math.floor(offset)) + 1} ${dir}/${stream}`],
              {},
            );
            const exitCode = decode(code.stdout).trim();
            return {
              data: new Uint8Array(data.stdout),
              exitCode: exitCode === "" ? undefined : Number(exitCode),
            };
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        kill: (id: string, signal: number) =>
          run(
            [
              "sh",
              "-c",
              `kill -${Math.floor(signal)} -- -$(cat /run/workspace/${id.replace(/[^0-9a-f-]/g, "")}/pid) 2>/dev/null || true`,
            ],
            {},
          ).pipe(
            Effect.asVoid,
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        /** A port on the machine: `x-alchemy-port` names it. */
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const port = Number(request.headers["x-alchemy-port"]);
          if (!Number.isInteger(port) || port <= 0) {
            return HttpServerResponse.text("x-alchemy-port is required\n", { status: 400 });
          }
          return yield* backend.port(port, request);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(HttpServerResponse.text(String(cause), { status: 502 })),
          ),
        ),

        refresh: (egress: DelegatedEgress) =>
          Effect.sync(() => {
            delegate(egress);
          }),

        grant: (hostConfig: HostConfig, egress: DelegatedEgress | undefined) =>
          backend
            .start(hostConfig, egress ? delegate(egress) : [], egress?.ttlMs)
            .pipe(Effect.mapError((error) => asWorkspaceError(error))),

        checkpoint: (session: string) =>
          Effect.flatMap(mountOf(session), (mount) => mount.checkpoint).pipe(
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        apply: (session: string, patches: ReadonlyArray<string>) =>
          Effect.flatMap(mountOf(session), (mount) => mount.apply(patches)).pipe(
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        snapshot: (session: string) =>
          Effect.flatMap(mountOf(session), (mount) => mount.snapshot).pipe(
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        call: (
          snapshot: Snapshot,
          command: string,
          options: RunOptions & { readonly patch: string; readonly keep?: boolean },
          hostConfig: HostConfig,
          egress: DelegatedEgress | undefined,
        ) =>
          Effect.gen(function* () {
            if (mounted) yield* detach(mounted.head);
            yield* detachHost;
            yield* state.storage.delete(IDLE_AT);
            yield* backend.start(hostConfig, egress ? delegate(egress) : [], egress?.ttlMs);
            const ran = yield* disk.call(snapshot, command, {
              dir: hostConfig.path,
              cache: CACHE,
              patch: options.patch,
              ...(options.keep ? { keep: true } : {}),
              ...(options.cwd ? { cwd: options.cwd } : {}),
              ...(options.env ? { env: options.env } : {}),
              ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            });
            if (ran.host) {
              yield* state.storage.put(HOST, ran.host.socket);
            } else {
              yield* Effect.ignore(Effect.andThen(wipe, idleFromNow));
            }
            const { host, ...rest } = ran;
            return { ...rest, kept: host !== undefined };
          }).pipe(
            Effect.onError(() => Effect.ignore(Effect.andThen(wipe, idleFromNow))),
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        hostCommit: (patch: string, full: boolean) =>
          Effect.gen(function* () {
            const socket = yield* state.storage.get<string>(HOST);
            if (!socket) return yield* fail("no command's processes are kept on this machine");
            return yield* disk.host(socket).commit(patch, { full });
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        hostDetach: (patch: string) =>
          Effect.gen(function* () {
            const socket = yield* state.storage.get<string>(HOST);
            if (!socket) {
              return { summary: { paths: [], bytes: 0, operations: 0 }, survivors: [] };
            }
            const detached = yield* disk.host(socket).detach(patch);
            yield* state.storage.delete(HOST);
            yield* Effect.ignore(Effect.andThen(wipe, idleFromNow));
            return detached;
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        diff: (from: Snapshot, to: Snapshot, patch: string | undefined, hostConfig: HostConfig) =>
          Effect.gen(function* () {
            yield* backend.start(hostConfig, [], undefined);
            return yield* disk.diff(from, to, patch ? { patch } : {});
          }).pipe(
            Effect.ensuring(Effect.ignore(idleFromNow)),
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        warm: (hostConfig: HostConfig) =>
          Effect.gen(function* () {
            if (mounted) return;
            yield* backend.start(hostConfig, [], undefined);
            yield* idleFromNow;
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        retire: () =>
          Effect.gen(function* () {
            if (mounted) yield* detach(mounted.head);
            yield* state.storage.delete(IDLE_AT);
            yield* backend.retire;
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        unmount: (session: string) =>
          Effect.gen(function* () {
            const detached = yield* detach(session);
            yield* wipe;
            yield* idleFromNow;
            // Collect garbage now and then, after an open, off the caller's path.
            const last = (yield* state.storage.get<number>("workspace:gc-at")) ?? 0;
            if (Date.now() - last > Duration.toMillis(GC_EVERY)) {
              yield* state.storage.put("workspace:gc-at", Date.now());
              yield* state.waitUntil(
                disk.gc(config.history !== undefined ? { history: config.history } : {}).pipe(
                  Effect.tap((report) => Effect.logInfo("workspace garbage collected", report)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("workspace garbage collection failed", cause),
                  ),
                ),
              );
            }
            return detached;
          }).pipe(Effect.mapError((error) => asWorkspaceError(error))),

        alarm: () =>
          Effect.gen(function* () {
            const idleAt = yield* state.storage.get<number>(IDLE_AT);
            if (mounted || idleAt === undefined || Date.now() < idleAt) return;
            if (yield* state.storage.get<string>(HOST)) return;
            yield* state.storage.delete(IDLE_AT);
            yield* backend.stop;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("stopping an idle machine failed", cause),
            ),
          ),
      };
    });
  });

/**
 * @internal The host Worker of workspace `config.id`: its sessions and
 * machines. At deploy it's given the volume's host and the machine's image;
 * at run time both come from the bindings deploy made.
 */
export const hostWorker = (
  config: HostConfig,
  deploy?: {
    readonly main: string;
    readonly dockerfile: string;
    /** The secret machines off Cloudflare present (an Output until deploy). */
    readonly token: unknown;
    readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, any>;
  },
) => {
  const Sessions = sessionObject(config.id);
  const Machines = machineObject(config.id);
  const Pools = poolObject(config.id);
  const provide = deploy?.provide ?? (<A, E, R>(effect: Effect.Effect<A, E, R>) => effect);
  return Worker<any>()(
    className(config.id, "Workspace"),
    {
      main: deploy?.main ?? "",
      compatibility: { flags: ["nodejs_compat"] },
      env: {
        [HOST_CONFIG]: JSON.stringify(config),
        ...(deploy ? { [HOST_TOKEN]: deploy.token } : {}),
      },
    } as never,
    provide(
      Effect.gen(function* () {
        yield* Sessions;
        yield* Machines;
        yield* Pools;
        const sessions = yield* Sessions;
        const env = (yield* WorkerEnvironment) as Record<string, unknown> | undefined;
        return {
          // Machines off Cloudflare reach their session's head and journal here.
          fetch: Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            const web = yield* HttpServerRequestModule.toWeb(request);
            const path = new URL(web.url).pathname;
            if (!path.startsWith("/heads") && !path.startsWith("/journal/")) {
              return HttpServerResponse.text("workspace host\n");
            }
            const token = env?.[HOST_TOKEN];
            if (
              typeof token !== "string" ||
              web.headers.get("authorization") !== `Bearer ${token}`
            ) {
              return HttpServerResponse.text("unauthorized\n", { status: 401 });
            }
            return HttpServerResponse.fromWeb(yield* serveHeads(sessions, web));
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
            ),
          ),
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Sessions.make(sessionImpl(config)),
            Machines.make(machineImpl(config, deploy?.dockerfile)),
            Pools.make(poolImpl(config)),
          ),
        ),
      ),
    ) as never,
  );
};

/** @internal The leases and commands of a workspace, from a Worker that yields it. */
export const connectWorkspace = Effect.fn(function* (descriptor: WorkspaceHostDescriptor) {
  const sessions = yield* sessionObject(descriptor.id).from(descriptor.script);
  const machines = yield* machineObject(descriptor.id).from(descriptor.script);
  return { sessions, machines };
});
