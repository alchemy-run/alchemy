import { DEFAULT_REGION } from "@distilled.cloud/archil/Credentials";
import * as Binding from "alchemy/Binding";
import type { MountBinding, MountCapability } from "alchemy/Mount";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Disk } from "./Disk.ts";
import { DiskUser } from "./DiskUser.ts";
import type { DiskMount, DiskMountOptions, DiskRef } from "./SandboxOptions.ts";

/** Where a disk mounts when no `path` is given (Archil's own default). */
export const DEFAULT_MOUNT_PATH = "/mnt/archil";

/** A run-time mount of a disk named at call time (`MountDisk()`). */
export interface MountAnyOptions extends Partial<DiskMountOptions> {
  /** The disk: a `DiskHandle`, or its id (`dsk-…`) as a job received it. */
  readonly disk: DiskRef | string;
  /** A disk token for that disk, e.g. from `DiskHandle.createToken`. */
  readonly token: string | Redacted.Redacted<string>;
  /** Region the disk lives in. @default the region bound at deploy */
  readonly region?: string;
}

/** `archil mount` or `archil unmount` failed. */
export class MountFailed extends Data.TaggedError("Archil.MountFailed")<{
  readonly disk: string;
  readonly path: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message() {
    return `archil mount ${this.disk} at ${this.path} exited ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

/** The host can't run the Archil client (no process spawner, e.g. a Worker). */
export class MountNotSupported extends Data.TaggedError("Archil.MountNotSupported")<{
  readonly message: string;
}> {}

/** The path is already mounted in this process with different options. */
export class MountConflict extends Data.TaggedError("Archil.MountConflict")<{
  readonly path: string;
  readonly message: string;
}> {}

export type MountError = MountFailed | MountNotSupported | MountConflict;

/**
 * One deploy-time disk, mounted at `path`. The same fields as a `mounts`
 * entry, so it can go straight into `Archil.Sandbox({ mounts })` or
 * `sandboxes.create({ mounts })`.
 */
export interface DiskMountRef extends DiskMount {
  readonly disk: Disk;
  readonly path: string;
  /**
   * Mount the disk for the life of the current scope and return its path.
   * In an `Archil.Sandbox` program the sandbox already mounts it, so this
   * returns the path at once. On other hosts it runs the FUSE client;
   * concurrent scopes that mount the same path share one mount, and the
   * last one to close flushes and unmounts, releasing any delegations the
   * mount held.
   */
  mount(): Effect.Effect<string, MountError, RuntimeContext | Scope.Scope>;
}

/** Mounts any disk the program names at run time. */
export interface MountAnyDiskClient {
  /**
   * Mount a disk with its token for the life of the current scope and
   * return the mount path.
   */
  mount(options: MountAnyOptions): Effect.Effect<string, MountError, RuntimeContext | Scope.Scope>;
}

/**
 * The Archil FUSE client, installed into a host's image. `archil mount`
 * needs `/dev/fuse` and `CAP_SYS_ADMIN`.
 */
export const archilClientCapability: MountCapability = {
  id: "archil",
  install: [
    "RUN (command -v apt-get >/dev/null && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fuse3 && rm -rf /var/lib/apt/lists/*) || (command -v apk >/dev/null && apk add --no-cache ca-certificates curl fuse3)",
    "RUN curl -fsSL https://archil.com/install | sh",
  ],
  requires: { fuse: true },
};

/**
 * Bind the Archil client capability onto the current host. A mount is a
 * host-only attachment (an image layer and a kernel feature), so this is
 * the one place Archil binds directly onto its host.
 */
const bindClientCapability = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  if (!host) return;
  // `Binding.Host` is typed as a bare `ResourceLike` (no `bind`): a host's
  // binding contract is only known per host type, and `MountBinding` is the
  // slice every mount-capable host accepts.
  yield* (
    host as unknown as { bind: (sid: string, data: MountBinding) => Effect.Effect<void> }
  ).bind("Archil.MountDisk", { mounts: [archilClientCapability] });
});

const modeFlags = (mode: DiskMountOptions["mode"]) =>
  mode === "shared"
    ? ["--shared"]
    : mode === "conditional"
      ? ["--conditional"]
      : mode === "read-only"
        ? ["--read-only"]
        : [];

const run = (
  spawner: ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string | Redacted.Redacted<string>> = {},
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(command, args, {
      env,
      extendEnv: true,
      shell: false,
      // A client stuck on the network may ignore SIGTERM; don't wait on it.
      forceKillAfter: "3 seconds",
    });
    let stderr = "";
    const reader = yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) => Effect.sync(() => void (stderr += chunk))),
      Effect.forkScoped,
    );
    // A client that never finishes attaching (no FUSE, no route to Archil)
    // is killed, and reported with what it printed so far.
    const exitCode = yield* handle.exitCode.pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.flatMap((code) =>
        Option.isSome(code)
          ? Effect.succeed(Number(code.value))
          : handle.kill().pipe(
              Effect.ignore,
              Effect.as(124),
              Effect.tap(() =>
                Effect.sync(
                  () =>
                    void (stderr +=
                      "\n(timed out after 60s: check that the host can reach Archil; a Cloudflare Container needs `start({ enableInternet: true })`)"),
                ),
              ),
            ),
      ),
    );
    // Let the stderr reader drain what's left.
    yield* Fiber.join(reader).pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
    return { exitCode, stderr };
  }).pipe(
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner, spawner),
    // The binary is missing or can't start: report it like a failed command.
    Effect.catch((cause) => Effect.succeed({ exitCode: 127, stderr: String(cause) })),
  );

/** The mounts this process holds, by path. */
interface Mounts {
  readonly lock: Semaphore.Semaphore;
  readonly byPath: Map<string, { readonly key: string; users: number }>;
}

const makeMounts = Effect.gen(function* () {
  return {
    lock: yield* Semaphore.make(1),
    byPath: new Map(),
  } satisfies Mounts;
});

// `archil unmount` returns before the client's daemon exits, and a mount at
// the same path fails until it has.
const isStillUnmounting = (e: MountError) =>
  e._tag === "Archil.MountFailed" && e.stderr.includes("older Archil process is still running");

/** Mount a disk for the life of the ambient scope. */
const mountFor = (
  spawner: Option.Option<ChildProcessSpawner["Service"]>,
  mounts: Mounts,
  input: {
    readonly disk: string;
    readonly token: Redacted.Redacted<string> | undefined;
    readonly region: string;
    readonly options: Partial<DiskMountOptions>;
  },
) =>
  Effect.gen(function* () {
    if (Option.isNone(spawner)) {
      return yield* new MountNotSupported({
        message:
          "Archil.MountDisk needs a host that can run processes (an Archil sandbox, a Container, Fly Machine, ECS task, or VM).",
      });
    }
    const path = input.options.path ?? DEFAULT_MOUNT_PATH;
    const target = input.options.subdirectory
      ? `${input.disk}:/${input.options.subdirectory.replace(/^\//, "")}`
      : input.disk;
    const args = [
      "mount",
      target,
      path,
      "--region",
      input.region,
      ...modeFlags(input.options.mode),
      ...(input.options.branch ? ["--branch", input.options.branch] : []),
      ...(input.options.force ? ["--force"] : []),
    ];
    const key = args.join(" ");
    const env: Record<string, string | Redacted.Redacted<string>> = input.token
      ? { ARCHIL_MOUNT_TOKEN: input.token }
      : {};
    const mount = Effect.gen(function* () {
      const result = yield* run(spawner.value, "archil", args, env);
      if (result.exitCode !== 0) {
        return yield* new MountFailed({ disk: input.disk, path, ...result });
      }
    }).pipe(
      Effect.retry({
        while: isStillUnmounting,
        schedule: Schedule.spaced("1 second"),
        times: 15,
      }),
    );
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const held = mounts.byPath.get(path);
        if (held !== undefined) {
          if (held.key !== key) {
            return yield* new MountConflict({
              path,
              message: `${path} is already mounted with \`archil ${held.key}\``,
            });
          }
          held.users++;
          return;
        }
        yield* run(spawner.value, "mkdir", ["-p", path]);
        yield* mount;
        mounts.byPath.set(path, { key, users: 1 });
      }).pipe(mounts.lock.withPermits(1)),
      () =>
        Effect.gen(function* () {
          const held = mounts.byPath.get(path);
          if (held === undefined || --held.users > 0) return;
          mounts.byPath.delete(path);
          yield* run(spawner.value, "archil", ["unmount", path], env);
        }).pipe(mounts.lock.withPermits(1)),
    );
    return path;
  });

/** How `MountDisk(disk)` mounts its disk: a `mounts` entry's options. */
export interface MountDiskOptions extends Partial<DiskMountOptions> {}

/** Options for `MountDisk()`, which mounts disks named at run time. */
export interface MountAnyDiskOptions {
  /**
   * Region of the disks the program mounts.
   * @default "aws-us-east-1"
   */
  region?: string;
}

/**
 * Mount an Archil disk where your program runs. `MountDisk(disk, options)`
 * returns a mount reference: the fields of a `mounts` entry (`disk`,
 * `path`, `mode`, …) plus `mount()`.
 *
 * - In an `Archil.Sandbox` program, the sandbox mounts the disk natively:
 *   the binding adds the entry to the sandbox's `mounts`, and `mount()`
 *   returns the path at once.
 * - On your own machines (a Cloudflare Container, an ECS task, a Fly
 *   Machine, or a VM), the binding installs the Archil client into the
 *   host's image and checks at plan time that the host provides FUSE.
 *   `mount()` runs the client for the life of the scope that called it.
 *   The host gets its own disk user (read-only for `mode: "read-only"`),
 *   so Archil refuses it any other disk and it never holds an API key.
 *
 * `MountDisk()` mounts whatever disk the program names, with a disk token
 * it receives at run time (e.g. from a control Worker's
 * `DiskHandle.createToken`).
 *
 * The client reaches Archil over the network, so start a Cloudflare
 * Container with `container.start({ enableInternet: true })`.
 *
 * ### Mounting in a Sandbox Program
 * **Example:** Serve a mounted disk from an Archil sandbox
 * ```typescript
 * export default class Api extends Archil.Sandbox<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const dataset = yield* Archil.MountDisk(Dataset, { path: "/data", mode: "read-only" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json(yield* fs.readDirectory(dataset.path));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Archil.MountDiskLive)),
 * ) {}
 * ```
 *
 * ### Mounting on Your Own Hosts
 * **Example:** Read a dataset in a Cloudflare Container
 * ```typescript
 * export default class Indexer extends Cloudflare.Container<Indexer>()(
 *   "Indexer",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const dataset = yield* Archil.MountDisk(Dataset, { path: "/data", mode: "read-only" });
 *     const fs = yield* FileSystem.FileSystem;
 *     return {
 *       fetch: Effect.scoped(
 *         Effect.gen(function* () {
 *           const path = yield* dataset.mount();
 *           return yield* HttpServerResponse.json(yield* fs.readDirectory(path));
 *         }),
 *       ),
 *     };
 *   }).pipe(Effect.provide(Archil.MountDiskLive)),
 * ) {}
 * ```
 *
 * **Example:** Write through a mount in an ECS task on EC2
 * ```typescript
 * const scratch = yield* Archil.MountDisk(Scratch, { path: "/scratch" });
 * // runtime
 * const path = yield* scratch.mount();
 * yield* fs.writeFileString(`${path}/result.json`, JSON.stringify(result));
 * ```
 *
 * ### Passing a Mount to a Sandbox
 * **Example:** Mount the same disk into a sandbox created per task
 * ```typescript
 * const workspace = yield* Archil.MountDisk(Workspace, { path: "/workspace", mode: "conditional" });
 * const sandboxes = yield* Archil.CreateSandbox();
 * // runtime
 * const sandbox = yield* sandboxes.create({ name: `task-${id}`, mounts: [workspace] });
 * ```
 *
 * ### Mounting Disks Named at Run Time
 * **Example:** Mount the disk a job names, with its token
 * ```typescript
 * const archil = yield* Archil.MountDisk();
 * const path = yield* archil.mount({ disk: job.diskId, token: job.token, path: "/work" });
 * ```
 *
 * @binding
 * @product Disk
 */
export interface MountDisk extends Binding.Service<
  MountDisk,
  "Archil.MountDisk",
  {
    (disk: Disk, options?: MountDiskOptions): Effect.Effect<DiskMountRef>;
    (disk?: undefined, options?: MountAnyDiskOptions): Effect.Effect<MountAnyDiskClient>;
  } & ((
    disk?: Disk,
    options?: MountDiskOptions & MountAnyDiskOptions,
  ) => Effect.Effect<DiskMountRef & MountAnyDiskClient>)
> {}

export const MountDisk = Binding.Service<MountDisk>("Archil.MountDisk");

type BindableHost = {
  readonly Type: string;
  readonly LogicalId: string;
  bind: (sid: string, data: object) => Effect.Effect<void>;
};

/** {@link MountDisk} over native sandbox mounts and the Archil FUSE client. */
export const MountDiskLive = Layer.effect(
  MountDisk,
  Effect.gen(function* () {
    const Users = yield* DiskUser;
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner);
    const mounts = yield* makeMounts;
    return Effect.fn(function* (disk?: Disk, options?: MountDiskOptions & MountAnyDiskOptions) {
      // `Binding.Host` is typed as a bare `ResourceLike` (no `bind`): a
      // host's binding contract is only known per host type.
      const host = (yield* Binding.Host) as BindableHost | undefined;
      if (disk === undefined) {
        yield* bindClientCapability;
        const client: MountAnyDiskClient = {
          mount: (input) =>
            mountFor(spawner, mounts, {
              disk: typeof input.disk === "string" ? input.disk : input.disk.diskId,
              token: typeof input.token === "string" ? Redacted.make(input.token) : input.token,
              region: input.region ?? options?.region ?? DEFAULT_REGION,
              options: input,
            }),
        };
        return client as DiskMountRef & MountAnyDiskClient;
      }
      const entry = {
        disk,
        path: options?.path ?? DEFAULT_MOUNT_PATH,
        mode: options?.mode,
        subdirectory: options?.subdirectory,
        queueMs: options?.queueMs,
        branch: options?.branch,
        force: options?.force,
      } satisfies DiskMount;
      if (host?.Type === "Archil.Sandbox") {
        // The sandbox mounts the disk itself: add it to the sandbox's mounts.
        if (!globalThis.__ALCHEMY_RUNTIME__) {
          yield* host.bind(`Archil.MountDisk(${disk.LogicalId})`, {
            mounts: [
              {
                diskId: disk.diskId,
                path: entry.path,
                mode: entry.mode,
                subdirectory: entry.subdirectory,
                queueMs: entry.queueMs,
                branch: entry.branch,
                force: entry.force,
              },
            ],
          });
        }
        const ref: DiskMountRef = { ...entry, mount: () => Effect.succeed(entry.path) };
        return ref as DiskMountRef & MountAnyDiskClient;
      }
      yield* bindClientCapability;
      const user = yield* Users(`${host?.LogicalId ?? "Script"}${disk.LogicalId}DiskUser`, {
        disk: disk.diskId,
        readOnly: options?.mode === "read-only" ? true : undefined,
      });
      const token = yield* user.token;
      const diskId = yield* disk.diskId;
      const region = yield* disk.region;
      const ref: DiskMountRef = {
        ...entry,
        mount: () =>
          Effect.gen(function* () {
            return yield* mountFor(spawner, mounts, {
              disk: yield* diskId,
              token: yield* token,
              region: yield* region,
              options: entry,
            });
          }),
      };
      return ref as DiskMountRef & MountAnyDiskClient;
    });
  }),
);
