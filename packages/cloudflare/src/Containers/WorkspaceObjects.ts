import type { SandboxClient, SandboxProcess } from "@alchemy.run/sandbox/Sandbox";
import { SandboxError } from "@alchemy.run/sandbox/Sandbox";
import {
  Volume as VolumeDeclaration,
  type Disk,
  type DiskMount,
  type Snapshot,
} from "@alchemy.run/sandbox/Volume";
import { WorkspaceError } from "@alchemy.run/sandbox/Workspace";
/**
 * The Durable Objects behind `Cloudflare.Containers.Workspace`, and the host
 * Worker that serves them. Runtime code only: the host Worker's bundle
 * imports this module (through WorkspaceHost.ts), so nothing here may pull in
 * deploy-time resources.
 *
 * NOT exported from `index.ts`.
 */
import type * as cf from "@cloudflare/workers-types";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { volumeBucketBinding } from "../Workers/VolumeHeads.ts";
import { Worker } from "../Workers/Worker.ts";
import { WorkerEnvironment } from "../Workers/WorkerRuntime.ts";
import { Container } from "./Container.ts";
import type { ContainerClient } from "./ContainerClient.ts";
import { registerControl } from "./EgressRelay.ts";
import type { ContainerInstanceType } from "./SandboxClient.ts";

/** The `host` of a workspace's descriptor. */
export const WORKSPACE_HOST = "Cloudflare.Containers.Workspace";

/** The host a machine's blockd reads and moves heads through. */
const HEADS_HOST = "workspace.alchemy.internal";

/** The env var holding a host Worker's {@link HostConfig}. */
export const HOST_CONFIG = "ALCHEMY_WORKSPACE_HOST";

/** How long a lease lives without renewal: an `open` renews it while it runs. */
const LEASE_TTL = Duration.minutes(2);

/** What a Worker that yields the workspace needs to reach its host. */
export interface WorkspaceHostDescriptor {
  readonly host: typeof WORKSPACE_HOST;
  /** The host Worker's script name. */
  readonly script: string;
  readonly id: string;
}

/** @internal What the host Worker is configured with, the same at deploy and at run time. */
export interface HostConfig {
  readonly id: string;
  readonly path: string;
  readonly instanceType: ContainerInstanceType;
  readonly idleMs: number;
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
  acquire(session: string, grant: string): Effect.Effect<Lease, WorkspaceError, RuntimeContext>;
  renew(session: string, lease: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  release(session: string, lease: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
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
  ): Effect.Effect<{ readonly dir: string }, WorkspaceError, RuntimeContext>;
  exec(
    command: string,
    options: {
      readonly cwd: string;
      readonly env?: Record<string, string>;
      readonly timeoutMs?: number;
    },
  ): Effect.Effect<ExecOutput, WorkspaceError, RuntimeContext>;
  unmount(session: string): Effect.Effect<Snapshot | undefined, WorkspaceError, RuntimeContext>;
}

/** Durable Object class names are JavaScript identifiers. */
const className = (id: string, kind: string) => `${id.replace(/[^A-Za-z0-9_$]/g, "_")}${kind}`;

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
 * record), and the leases of the `open`s running on it. Overlapping opens
 * with the same grant share one mount; the last to release snapshots it.
 */
const sessionImpl = (config: HostConfig) =>
  Effect.gen(function* () {
    const volume = yield* volumeOf(config.id);
    // Through this Worker's own script: the two objects reference each other.
    const machines = yield* machineObject(config.id).from(thisWorker);
    const env = (yield* WorkerEnvironment) as Record<string, unknown> | undefined;
    const prefix = `volumes/${config.id}`;
    const bucket = () => env?.[volumeBucketBinding(config.id)] as cf.R2Bucket | undefined;
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const headLock = yield* Semaphore.make(1);
      const openLock = yield* Semaphore.make(1);
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

      /** Heads changed through the R2 client (fork, undo, delete): drop the cache. */
      const viaVolume = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        headLock.withPermits(1)(
          Effect.ensuring(
            effect,
            Effect.sync(() => (cached = undefined)),
          ),
        );

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
      const saveOpens = (opens: Opens) =>
        Effect.gen(function* () {
          yield* state.storage.put(OPENS, opens);
          const expiries = Object.values(opens.leases);
          if (expiries.length > 0) yield* state.storage.setAlarm(Math.min(...expiries));
        });

      /** Unmount if nothing holds the mount any more. */
      const settle = Effect.fn(function* (session: string, opens: Opens) {
        if (Object.keys(opens.leases).length > 0 || !opens.machine) {
          yield* saveOpens(opens);
          return;
        }
        const unmounted = yield* Effect.exit(machines.getByName(opens.machine).unmount(session));
        if (unmounted._tag === "Failure") {
          // The next mount recovers whatever the journal holds.
          yield* Effect.logWarning(`unmounting ${session} failed`, unmounted.cause);
        }
        yield* saveOpens({ leases: {} });
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

      //#endregion

      return {
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

        acquire: (session: string, grant: string) =>
          whenReady(
            session,
            (opens) => idle(opens) || opens.grant === grant,
            Effect.fn(function* (opens) {
              const lease = crypto.randomUUID();
              const expires = Date.now() + Duration.toMillis(LEASE_TTL);
              if (!idle(opens)) {
                yield* saveOpens({ ...opens, leases: { ...opens.leases, [lease]: expires } });
                return { lease, machine: opens.machine!, dir: opens.dir! };
              }
              // A session that doesn't exist yet starts from the base.
              if (
                (yield* viaVolume(volume.head(session)).pipe(Effect.mapError(asWorkspaceError))) ===
                undefined
              ) {
                yield* viaVolume(volume.fork(session)).pipe(Effect.mapError(asWorkspaceError));
              }
              const machine = session;
              const { dir } = yield* machines.getByName(machine).mount(session, config);
              yield* saveOpens({ leases: { [lease]: expires }, session, grant, machine, dir });
              return { lease, machine, dir };
            }),
          ),

        renew: (session: string, lease: string) =>
          openLock.withPermits(1)(
            Effect.gen(function* () {
              const opens = yield* loadOpens;
              if (!(lease in opens.leases)) {
                return yield* fail(`the lease on ${session} expired`);
              }
              yield* saveOpens({
                ...opens,
                leases: { ...opens.leases, [lease]: Date.now() + Duration.toMillis(LEASE_TTL) },
              });
            }),
          ),

        release: (session: string, lease: string) =>
          openLock.withPermits(1)(
            Effect.gen(function* () {
              const opens = yield* loadOpens;
              const { [lease]: _released, ...leases } = opens.leases;
              yield* settle(session, { ...opens, leases });
            }),
          ),

        fork: (session: string, from: string) =>
          whenReady(session, idle, () =>
            viaVolume(volume.fork(session, { from })).pipe(
              Effect.asVoid,
              Effect.mapError(asWorkspaceError),
            ),
          ),

        undo: (session: string, steps: number) =>
          whenReady(session, idle, () =>
            Effect.gen(function* () {
              const history = yield* volume.history(session, { limit: steps + 1 });
              const target = history[steps];
              if (target === undefined) {
                return yield* fail(`${session} has fewer than ${steps} snapshots to undo`);
              }
              yield* viaVolume(volume.reset(session, target));
            }).pipe(Effect.mapError(asWorkspaceError)),
          ),

        history: (session: string, limit: number) =>
          volume.history(session, { limit }).pipe(Effect.mapError(asWorkspaceError)),

        remove: (session: string) =>
          whenReady(session, idle, () =>
            viaVolume(volume.drop(session)).pipe(Effect.mapError(asWorkspaceError)),
          ),

        alarm: () =>
          openLock
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
            .pipe(Effect.catch((error) => Effect.logWarning("expiring leases failed", error))),
      };
    });
  });

/** The Worker this runs in, for `.from`: its objects reference each other. */
const thisWorker = Effect.suspend(() => Worker) as unknown as Effect.Effect<never, never, Worker>;

const asWorkspaceError = (error: { readonly message: string }) =>
  error instanceof WorkspaceError ? error : fail(error.message, error);

/**
 * @internal A machine: one container with blockd, serving one session's
 * mount at a time. It answers its blockd's head requests by asking the
 * session's Durable Object.
 */
const machineImpl = (config: HostConfig, dockerfile?: string) =>
  Effect.gen(function* () {
    const Box = machineContainer(config.id, dockerfile);
    const container = yield* Box;
    const disk: Disk = yield* volumeOf(config.id).on(
      Object.assign(Effect.succeed(asSandbox(container)), {
        Application: (Box as unknown as { Application: Effect.Effect<unknown> }).Application,
      }) as never,
    );
    const sessions = yield* sessionObject(config.id).from(thisWorker);
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      let mounted: DiskMount | undefined;

      registerControl(state.raw, {
        key: "alchemy:workspace-heads",
        host: HEADS_HOST,
        handle: (request) =>
          Effect.gen(function* () {
            const url = new URL(request.url);
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
            Effect.catchCause((cause) =>
              Effect.succeed(new Response(String(cause), { status: 503 })),
            ),
          ),
      });

      const detach = Effect.fn(function* (session: string) {
        if (mounted?.head === session) {
          const snapshot = yield* mounted.detach;
          mounted = undefined;
          return snapshot;
        }
        // This object restarted while the container kept the mount.
        const reply = yield* asSandbox(container)
          .exec([
            "sh",
            "-c",
            `[ -S /run/blockd/${session}.sock ] && blockd control --socket /run/blockd/${session}.sock --request '{"op":"detach"}' || true`,
          ])
          .pipe(
            Effect.flatMap((process) => process.output()),
            Effect.scoped,
          );
        const match = /"snapshot":"([0-9a-f]+)"/.exec(decode(reply.stdout));
        return match?.[1];
      });

      return {
        mount: (session: string, hostConfig: HostConfig) =>
          Effect.gen(function* () {
            if (mounted?.head === session) return { dir: mounted.dir };
            if (mounted) yield* detach(mounted.head);
            yield* container.start({ instance: hostConfig.instanceType, enableInternet: true });
            yield* container.setInactivityTimeout(hostConfig.idleMs);
            mounted = yield* disk.mount(session, {
              dir: hostConfig.path,
              heads: `http://${HEADS_HOST}/heads`,
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
          Effect.gen(function* () {
            const process = yield* container.exec(["sh", "-c", command], {
              cwd: options.cwd,
              ...(options.env ? { env: options.env } : {}),
            } as never);
            const output = yield* process.output();
            return {
              exitCode: output.exitCode,
              stdout: decode(output.stdout),
              stderr: decode(output.stderr),
            };
          }).pipe(
            options.timeoutMs === undefined
              ? (effect) => effect
              : Effect.timeoutOrElse({
                  duration: Duration.millis(options.timeoutMs),
                  orElse: () => Effect.fail(fail(`${command} timed out`)),
                }),
            Effect.scoped,
            Effect.mapError((error) => asWorkspaceError(error)),
          ),

        unmount: (session: string) =>
          detach(session).pipe(Effect.mapError((error) => asWorkspaceError(error))),
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
    readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, any>;
  },
) => {
  const Sessions = sessionObject(config.id);
  const Machines = machineObject(config.id);
  const provide = deploy?.provide ?? (<A, E, R>(effect: Effect.Effect<A, E, R>) => effect);
  return Worker<any>()(
    className(config.id, "Workspace"),
    {
      main: deploy?.main ?? "",
      compatibility: { flags: ["nodejs_compat"] },
      env: { [HOST_CONFIG]: JSON.stringify(config) },
    } as never,
    provide(
      Effect.gen(function* () {
        yield* Sessions;
        yield* Machines;
        return {
          fetch: Effect.succeed(new Response("workspace host\n") as never),
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Sessions.make(sessionImpl(config)),
            Machines.make(machineImpl(config, deploy?.dockerfile)),
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
