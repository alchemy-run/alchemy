import type { Named } from "alchemy/Named";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Sandbox, SandboxClient, SandboxError } from "./Sandbox.ts";

/** A volume operation failed. */
export class VolumeError extends Data.TaggedError("VolumeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A head moved since it was read: someone else committed or reset it first. */
export class VolumeConflict extends Data.TaggedError("VolumeConflict")<{
  readonly message: string;
  readonly head: string;
}> {}

/** A snapshot of a volume: the id of an immutable manifest. */
export type Snapshot = string;

/**
 * A volume's heads: named pointers to snapshots. Every operation here is
 * metadata only (no machine runs, nothing is copied).
 */
export interface VolumeHeads {
  /** The snapshot `head` points at, if it exists. */
  head(name: string): Effect.Effect<Snapshot | undefined, VolumeError, RuntimeContext>;
  /**
   * A new head `to` on the snapshot `from` points at (`from` defaults to the
   * volume's base image). Instant: nothing is copied.
   */
  fork(
    to: string,
    options?: { readonly from?: string },
  ): Effect.Effect<Snapshot, VolumeError | VolumeConflict, RuntimeContext>;
  /** Points `head` at `snapshot`: a rewind, or adopting another fork's work. */
  reset(
    head: string,
    snapshot: Snapshot,
  ): Effect.Effect<void, VolumeError | VolumeConflict, RuntimeContext>;
  /** Deletes `head`; its snapshots stay until garbage collection. */
  drop(head: string): Effect.Effect<void, VolumeError | VolumeConflict, RuntimeContext>;
  /** `head`'s snapshot and its ancestors, newest first: one per committed command. */
  history(
    head: string,
    options?: { readonly limit?: number },
  ): Effect.Effect<ReadonlyArray<Snapshot>, VolumeError, RuntimeContext>;
}

/** What `exec` returns. */
export interface DiskExecOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `exec` options. */
export interface DiskExecOptions {
  /** Where the volume is mounted in the sandbox. @default "/volumes/<head>" */
  readonly dir?: string;
  /** How it's attached; `auto` picks the best the host allows. @default "auto" */
  readonly mode?: "auto" | "ublk" | "nbd" | "loop";
  readonly env?: Record<string, string>;
}

/** `mount` options. */
export interface DiskMountOptions {
  /** Where the volume is mounted in the sandbox. */
  readonly dir: string;
  /** How it's attached; `auto` picks the best the host allows. @default "auto" */
  readonly mode?: DiskExecOptions["mode"];
  /**
   * Where blockd reads and moves the head: a coordinator's URL (`blockd
   * --heads`). Omitted, the store's own heads.
   */
  readonly heads?: string;
  /**
   * Where blockd keeps journal entries: a coordinator's URL (`blockd
   * --journal`) that appends and checks the lease in one request. Omitted,
   * the store.
   */
  readonly journal?: string;
  /** Sync the journal every this many seconds even if nobody `fsync`s. @default 5 */
  readonly flushEvery?: number;
  readonly env?: Record<string, string>;
}

/** A head mounted in a sandbox until {@link detach}. */
export interface DiskMount {
  readonly head: string;
  readonly dir: string;
  /** The attach mode blockd picked. */
  readonly mode: string;
  /** The lease epoch this mount writes under. */
  readonly epoch: number;
  /** Make every write so far durable in the journal. */
  readonly sync: Effect.Effect<void, VolumeError | SandboxError, RuntimeContext>;
  /** Unmount, snapshot and stop blockd; returns the snapshot. */
  readonly detach: Effect.Effect<Snapshot, VolumeError | SandboxError, RuntimeContext>;
}

/**
 * A volume on a sandbox: its heads, and `exec` to run a command in the
 * sandbox with a head mounted. The command's writes are committed as a new
 * snapshot of that head when it exits.
 */
export interface Disk extends VolumeHeads {
  /**
   * Runs `command` (with `sh -c`) in the started sandbox, in `head`
   * mounted at `dir`, then commits what it wrote. One command per head at a
   * time: run concurrent commands on forks.
   */
  exec(
    head: string,
    command: string,
    options?: DiskExecOptions,
  ): Effect.Effect<DiskExecOutput, VolumeError | SandboxError, RuntimeContext>;
  /**
   * Mounts `head` at `dir` and leaves it mounted, for many commands (run
   * them with the sandbox's `exec`), until the returned mount's `detach`
   * snapshots it. Taking the head's lease supersedes any other mount of it.
   */
  mount(
    head: string,
    options: DiskMountOptions,
  ): Effect.Effect<DiskMount, VolumeError | SandboxError, RuntimeContext>;
  /**
   * Garbage-collect the store from this sandbox: delete what no head can
   * reach (keeping `history` snapshots per head, all by default), sparing
   * anything younger than `graceSeconds`.
   */
  gc(options?: {
    readonly history?: number;
    readonly graceSeconds?: number;
  }): Effect.Effect<Record<string, unknown>, VolumeError | SandboxError, RuntimeContext>;
}

/**
 * @internal What a host binds for a declaration and the owning Worker reads
 * at run time: where the volume's store is, and its base image's head.
 */
export interface VolumeHostDescriptor {
  readonly host: string;
  /** The store, as blockd takes it: `s3://<bucket>/<prefix>`. */
  readonly store: string;
  /** The head every fork starts from by default: the base image. */
  readonly base: string;
}

/** @internal The service a host constructor provides for declaration `id`. */
export interface VolumeHostService {
  /** Resolved at deploy (bucket names are Outputs until then). */
  readonly descriptor: Output.Output<VolumeHostDescriptor>;
  /**
   * Deploy time: install blockd into a sandbox's image (the host resource `Sandbox.Application` gives).
   */
  readonly install: (image: unknown) => Effect.Effect<void, never, any>;
  /**
   * What a sandbox's command needs to reach the store (credentials and
   * endpoint), as a JSON object of environment variables. The yielding
   * Worker holds it as a secret and passes it to each `exec`: it is never
   * baked into the sandbox's image.
   */
  readonly storeEnv: Output.Output<Redacted.Redacted<string>>;
  /** Deploy time: grant the yielding Worker access to the volume's heads. */
  readonly bind: Effect.Effect<void, never, any>;
}

/** @internal Connects a declaration's heads from inside a Worker or Durable Object. */
export class VolumeRuntime extends Context.Service<
  VolumeRuntime,
  {
    readonly connect: (
      id: string,
      descriptor: VolumeHostDescriptor,
    ) => Effect.Effect<VolumeHeads, never, any>;
  }
>()("alchemy/Sandbox/VolumeRuntime") {}

/** @internal The service a host constructor provides for declaration `id`. */
export const volumeHost = (id: string) =>
  Context.Service<Volume.Host<unknown>, VolumeHostService>(`alchemy/Sandbox/Volume<${id}>`);

const descriptorKey = (id: string) => sanitizeKey(`ALCHEMY_VOLUME_${id}`);
const storeEnvKey = (id: string) => sanitizeKey(`ALCHEMY_VOLUME_${id}_STORE_ENV`);

/** @internal Marks a volume declaration. */
export const VolumeTypeId = "~alchemy/Sandbox/Volume" as const;

const connectHeads = Effect.fn(function* (id: string) {
  const runtime = yield* Effect.serviceOption(VolumeRuntime);
  if (Option.isNone(runtime)) {
    return yield* Effect.die(
      new VolumeError({
        message: `Volume '${id}' can only be yielded inside a Worker or Durable Object.`,
      }),
    );
  }
  const host = yield* Effect.serviceOption(volumeHost(id));
  const ctx = yield* CurrentRuntimeContext;
  if (Option.isSome(host) && !globalThis.__ALCHEMY_RUNTIME__) {
    yield* host.value.bind;
    if (ctx) {
      yield* ctx.set(descriptorKey(id), host.value.descriptor);
      yield* ctx.set(storeEnvKey(id), host.value.storeEnv);
    }
  }
  const descriptor = ctx ? yield* ctx.get<VolumeHostDescriptor>(descriptorKey(id)) : undefined;
  // At deploy the descriptor is an unresolved Output: heads aren't used then.
  const resolved: VolumeHostDescriptor = descriptor ?? { host: "unresolved", store: "", base: "" };
  if (Option.isNone(host) && descriptor === undefined) {
    return yield* Effect.die(
      new VolumeError({
        message: `Volume '${id}' has no host: provide one (e.g. Cloudflare.R2.Volume(${id}, …)) on the stack.`,
      }),
    );
  }
  // Read when a command runs: at deploy it's an unresolved Output.
  const storeEnv = Effect.gen(function* () {
    const value = ctx
      ? yield* ctx.get<Redacted.Redacted<string> | string>(storeEnvKey(id))
      : undefined;
    if (value === undefined) {
      return yield* new VolumeError({
        message: `Volume '${id}' has no store credentials in this Worker.`,
      });
    }
    const text = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    return yield* Effect.try({
      try: () => JSON.parse(text) as Record<string, string>,
      catch: (cause) =>
        new VolumeError({ message: `Volume '${id}' has malformed store credentials.`, cause }),
    });
  });
  return { heads: yield* runtime.value.connect(id, resolved), descriptor: resolved, storeEnv };
});

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const makeDisk = (
  heads: VolumeHeads,
  descriptor: VolumeHostDescriptor,
  storeEnv: Effect.Effect<Record<string, string>, VolumeError>,
  sandbox: SandboxClient<any, any>,
): Disk => ({
  ...heads,
  exec: Effect.fn(function* (head: string, command: string, options: DiskExecOptions = {}) {
    const env = yield* storeEnv;
    const dir = options.dir ?? `/volumes/${head}`;
    const argv = [
      "blockd",
      "exec",
      "--store",
      descriptor.store,
      "--head",
      head,
      "--cache",
      `/var/cache/blockd/${head}.cache`,
      "--dir",
      dir,
      "--mode",
      options.mode ?? "auto",
      "--command",
      command,
    ];
    return yield* run(sandbox, `mkdir -p /var/cache/blockd && exec ${argv.map(quote).join(" ")}`, {
      ...options.env,
      ...env,
    });
  }),
  gc: Effect.fn(function* (
    options: { readonly history?: number; readonly graceSeconds?: number } = {},
  ) {
    const argv = [
      "blockd",
      "gc",
      "--store",
      descriptor.store,
      "--grace-seconds",
      String(options.graceSeconds ?? 3600),
      ...(options.history !== undefined ? ["--history", String(options.history)] : []),
    ];
    const ran = yield* run(sandbox, argv.map(quote).join(" "), yield* storeEnv);
    if (ran.exitCode !== 0) {
      return yield* new VolumeError({ message: `garbage collection failed: ${ran.stderr}` });
    }
    return yield* Effect.try({
      try: () => JSON.parse(ran.stdout.trim()) as Record<string, unknown>,
      catch: (cause) => new VolumeError({ message: `blockd gc said ${ran.stdout}`, cause }),
    });
  }),
  mount: Effect.fn(function* (head: string, options: DiskMountOptions) {
    const env = { ...options.env, ...(yield* storeEnv) };
    const socket = `/run/blockd/${head}.sock`;
    const out = `/run/blockd/${head}.out`;
    const log = `/run/blockd/${head}.log`;
    const argv = [
      "blockd",
      "mount",
      "--store",
      descriptor.store,
      "--head",
      head,
      "--cache",
      `/var/cache/blockd/${head}.cache`,
      "--dir",
      options.dir,
      "--control",
      socket,
      "--mode",
      options.mode ?? "auto",
      "--flush-every",
      String(options.flushEvery ?? 5),
      ...(options.heads ? ["--heads", options.heads] : []),
      ...(options.journal ? ["--journal", options.journal] : []),
    ];
    // blockd outlives this command: it serves the mount until a detach.
    const script = [
      "mkdir -p /run/blockd /var/cache/blockd",
      `rm -f ${quote(socket)} ${quote(out)}`,
      `nohup ${argv.map(quote).join(" ")} > ${quote(out)} 2> ${quote(log)} < /dev/null &`,
      "pid=$!",
      "for i in $(seq 1 1200); do",
      `  if grep -q '"mounted"' ${quote(out)} 2>/dev/null; then cat ${quote(out)}; exit 0; fi`,
      `  if ! kill -0 "$pid" 2>/dev/null; then cat ${quote(log)} >&2; exit 1; fi`,
      "  sleep 0.05",
      "done",
      `cat ${quote(log)} >&2; exit 1`,
    ].join("\n");
    const started = yield* run(sandbox, script, env);
    if (started.exitCode !== 0) {
      return yield* new VolumeError({ message: `mounting ${head} failed: ${started.stderr}` });
    }
    const ready = yield* Effect.try({
      try: () =>
        JSON.parse(started.stdout.trim().split("\n").pop()!) as {
          readonly mode: string;
          readonly epoch: number;
        },
      catch: (cause) =>
        new VolumeError({ message: `blockd mount said ${JSON.stringify(started.stdout)}`, cause }),
    });
    const control = Effect.fn(function* (request: string) {
      const reply = yield* run(
        sandbox,
        `blockd control --socket ${quote(socket)} --request ${quote(request)}`,
        {},
      );
      const parsed = yield* Effect.try({
        try: () =>
          JSON.parse(reply.stdout.trim()) as {
            readonly ok: boolean;
            readonly snapshot?: Snapshot;
            readonly error?: string;
          },
        catch: () => new VolumeError({ message: `blockd control: ${reply.stdout}${reply.stderr}` }),
      });
      if (!parsed.ok) {
        return yield* new VolumeError({ message: `blockd ${request}: ${parsed.error}` });
      }
      return parsed;
    });
    return {
      head,
      dir: options.dir,
      mode: ready.mode,
      epoch: ready.epoch,
      sync: Effect.asVoid(control(`{"op":"sync"}`)),
      detach: Effect.map(control(`{"op":"detach"}`), (reply) => reply.snapshot!),
    } satisfies DiskMount;
  }),
});

/** Runs `script` with `sh -c` in the sandbox and waits for it. */
const run = (sandbox: SandboxClient<any, any>, script: string, env: Record<string, string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* sandbox.exec(["sh", "-c", script], { env });
      const output = yield* process.output();
      const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
      return {
        exitCode: output.exitCode,
        stdout: decode(output.stdout),
        stderr: decode(output.stderr),
      } satisfies DiskExecOutput;
    }),
  );

/**
 * A volume declaration: a disk that lives in object storage, forked per
 * session from a base image, attached to a sandbox only for the length of
 * one command. A host constructor (`Cloudflare.R2.Volume`) provides where
 * it's stored and the base image.
 *
 * ### Declaring a volume
 * **Example:** A workspace
 * ```typescript
 * // src/Workspace.ts
 * import * as Sandbox from "@alchemy.run/sandbox";
 *
 * export class Workspace extends Sandbox.Volume<Workspace>()("Workspace") {}
 * ```
 *
 * ### Using it from a Durable Object
 * `Workspace.on(Machine)` installs blockd in the sandbox's image at deploy;
 * at run time it gives the volume's heads and `exec`.
 *
 * **Example:** A session's disk: fork, run, keep
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const machine = yield* Machine;
 *     const disk = yield* Workspace.on(Machine);
 *     return Effect.gen(function* () {
 *       return {
 *         run: Effect.fn(function* (session: string, command: string) {
 *           if (!(yield* disk.head(session))) yield* disk.fork(session);
 *           yield* machine.start({ size: "small" });
 *           return yield* disk.exec(session, command);
 *         }),
 *         rewind: Effect.fn(function* (session: string, steps: number) {
 *           const history = yield* disk.history(session, { limit: steps + 1 });
 *           yield* disk.reset(session, history[steps]!);
 *         }),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Sandbox
 * @category Sandbox
 */
export const Volume =
  <Self>() =>
  <const Id extends string>(id: Id): Volume.Decl<Self, Id> => {
    const host = volumeHost(id);
    const heads = Effect.map(connectHeads(id), ({ heads }) => heads);
    return Object.assign(
      class {},
      Effectable.Prototype({ label: `Sandbox.Volume<${id}>`, evaluate: () => heads }),
      {
        [VolumeTypeId]: VolumeTypeId,
        "~alchemy/Id": id,
        LogicalId: id,
        on: (sandbox: Sandbox.Decl.Any) =>
          Effect.gen(function* () {
            if (!globalThis.__ALCHEMY_RUNTIME__) {
              const provided = yield* Effect.serviceOption(host);
              if (Option.isSome(provided))
                yield* provided.value.install(yield* sandbox.Application);
            }
            const { heads, descriptor, storeEnv } = yield* connectHeads(id);
            return makeDisk(heads, descriptor, storeEnv, yield* sandbox);
          }),
      },
    ) as unknown as Volume.Decl<Self, Id>;
  };

export declare namespace Volume {
  /** The service a host constructor's Layer provides for declaration `Self`. */
  export interface Host<Self> {
    readonly "~alchemy/VolumeHost": Self;
  }

  export interface Decl<Self = any, Id extends string = string>
    extends Effect.Effect<VolumeHeads, never, Host<Self>>, Named<Id> {
    new (_: never): VolumeHeads;
    readonly [VolumeTypeId]: typeof VolumeTypeId;
    readonly LogicalId: Id;
    /**
     * The volume on a sandbox the same Durable Object yields: installs blockd
     * and the store's credentials into the sandbox's image at deploy.
     */
    on<S extends Sandbox.Decl.Any>(
      sandbox: S,
    ): Effect.Effect<Disk, never, Host<Self> | Effect.Services<S>>;
  }
  export namespace Decl {
    export type Any = Decl<any, string>;
  }
}
