import type { Named } from "alchemy/Named";
import type * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { SandboxEgress, SandboxPort, SandboxProcess } from "./Sandbox.ts";

/** A workspace operation failed: the host, the store, or the machine. */
export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A snapshot of a session: the id of an immutable manifest. */
export type Snapshot = string;

/** Options for a command in a session. */
export interface WorkspaceExecOptions {
  /** The working directory. @default the workspace's `path` */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Kill the command after this long. */
  readonly timeout?: Duration.Input;
}

/** What a finished command printed, and its exit code. */
export interface WorkspaceExecOutput {
  /** Nonzero exit codes are returned, not failed. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for `open`. */
export interface WorkspaceOpenOptions {
  /**
   * What the session's commands may reach, and with which credentials.
   * Applies to the whole machine for as long as the session is open: an
   * `open` with a different grant waits until the current one closes.
   */
  readonly egress?: ReadonlyArray<SandboxEgress>;
}

/**
 * An open session: its disk is mounted on a machine for as long as the
 * `open` that gave it runs. Every command here sees the same files.
 */
export interface WorkspaceSession {
  readonly name: string;
  /** Run `command` with `sh -c` and wait for it. */
  exec(
    command: string,
    options?: WorkspaceExecOptions,
  ): Effect.Effect<WorkspaceExecOutput, WorkspaceError, RuntimeContext>;
  /** Start `command` and stream it. Closing the scope kills it. */
  spawn(
    command: string,
    options?: WorkspaceExecOptions,
  ): Effect.Effect<SandboxProcess, WorkspaceError, RuntimeContext | Scope.Scope>;
  /** A port inside the session's machine, e.g. a server `spawn` started. */
  port(port: number): Effect.Effect<SandboxPort, WorkspaceError, RuntimeContext>;
}

/**
 * A workspace: forkable disks, one per session, that live in object
 * storage and are mounted on a machine only while something runs in them.
 * What `yield* Workspace` returns, the same on every host.
 */
export interface WorkspaceClient<Self = any> {
  /**
   * Run `effect` with `session` open: its disk is mounted for exactly as
   * long as the effect runs, and snapshotted when it ends, whether it
   * succeeds, fails or is interrupted. Inside, `yield* Workspace.Session`
   * gives the session. A session that doesn't exist yet starts from the
   * workspace's base.
   *
   * Two `open`s of one session that run at the same time share the mount
   * and its snapshot.
   */
  open<A, E, R>(
    session: string,
    options: WorkspaceOpenOptions,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WorkspaceError, Exclude<R, Workspace.Session<Self>> | RuntimeContext>;
  /** `open` around one command. */
  exec(
    session: string,
    command: string,
    options?: WorkspaceExecOptions & WorkspaceOpenOptions,
  ): Effect.Effect<WorkspaceExecOutput, WorkspaceError, RuntimeContext>;
  /** A new session `to` on `from`'s latest snapshot. Instant: nothing is copied. */
  fork(from: string, to: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  /** Move `session` back `steps` snapshots (one per `open`). @default 1 */
  undo(session: string, steps?: number): Effect.Effect<void, WorkspaceError, RuntimeContext>;
  /** `session`'s snapshots, newest first. */
  history(
    session: string,
    options?: { readonly limit?: number },
  ): Effect.Effect<ReadonlyArray<Snapshot>, WorkspaceError, RuntimeContext>;
  /** Delete `session`; its snapshots stay until garbage collection. */
  delete(session: string): Effect.Effect<void, WorkspaceError, RuntimeContext>;
}

/**
 * @internal What a host gives the runtime: open a session for the length
 * of a scope, and the metadata operations. The host owns mounting,
 * sharing a mount between overlapping opens, and the snapshot when the
 * last one releases.
 */
export interface WorkspaceConnection {
  readonly acquire: (
    session: string,
    options: WorkspaceOpenOptions,
  ) => Effect.Effect<WorkspaceSession, WorkspaceError, RuntimeContext | Scope.Scope>;
  readonly fork: WorkspaceClient["fork"];
  readonly undo: WorkspaceClient["undo"];
  readonly history: WorkspaceClient["history"];
  readonly delete: WorkspaceClient["delete"];
}

/**
 * @internal Connects a declaration to its host from inside a Worker or
 * Durable Object. Provided by the Worker platform.
 */
export class WorkspaceRuntime extends Context.Service<
  WorkspaceRuntime,
  {
    readonly connect: (
      id: string,
      descriptor: unknown,
    ) => Effect.Effect<WorkspaceConnection, never, any>;
  }
>()("alchemy/Sandbox/WorkspaceRuntime") {}

/** @internal The service a host constructor provides for declaration `id`. */
export interface WorkspaceHostService {
  /** What the runtime needs to reach the host; resolved at deploy. */
  readonly descriptor: Output.Output<unknown>;
  /** Deploy time: grant the yielding Worker access to the host. */
  readonly bind: Effect.Effect<void, never, any>;
}

/** @internal */
export const workspaceHost = (id: string) =>
  Context.Service<Workspace.Host<unknown>, WorkspaceHostService>(
    `alchemy/Sandbox/Workspace<${id}>`,
  );

/** @internal Marks a workspace declaration. */
export const WorkspaceTypeId = "~alchemy/Sandbox/Workspace" as const;

const descriptorKey = (id: string) => sanitizeKey(`ALCHEMY_WORKSPACE_${id}`);

const connect = Effect.fn(function* (id: string) {
  const runtime = yield* Effect.serviceOption(WorkspaceRuntime);
  if (Option.isNone(runtime)) {
    return yield* Effect.die(
      new WorkspaceError({
        message: `Workspace '${id}' can only be yielded inside a Worker or Durable Object.`,
      }),
    );
  }
  const host = yield* Effect.serviceOption(workspaceHost(id));
  const ctx = yield* CurrentRuntimeContext;
  if (Option.isSome(host) && !globalThis.__ALCHEMY_RUNTIME__) {
    yield* host.value.bind;
    if (ctx) yield* ctx.set(descriptorKey(id), host.value.descriptor);
  }
  const descriptor = ctx ? yield* ctx.get<unknown>(descriptorKey(id)) : undefined;
  if (Option.isNone(host) && descriptor === undefined) {
    return yield* Effect.die(
      new WorkspaceError({
        message: `Workspace '${id}' has no host: provide one (e.g. Cloudflare.Containers.Workspace(${id}, …)) on the stack.`,
      }),
    );
  }
  return yield* runtime.value.connect(id, descriptor);
});

const makeClient = (
  connection: WorkspaceConnection,
  tag: Context.Service<Workspace.Session<any>, WorkspaceSession>,
): WorkspaceClient => ({
  open: (session, options, effect) =>
    Effect.scoped(
      Effect.flatMap(connection.acquire(session, options), (opened) =>
        Effect.provideService(effect, tag, opened),
      ),
    ),
  exec: (session, command, { egress, ...options } = {}) =>
    Effect.scoped(
      Effect.flatMap(connection.acquire(session, { egress }), (opened) =>
        opened.exec(command, options),
      ),
    ),
  fork: connection.fork,
  undo: connection.undo,
  history: connection.history,
  delete: connection.delete,
});

/**
 * A workspace declaration: forkable disks, one per session, kept in object
 * storage and mounted on a machine only while something runs in them. A
 * host constructor (`Cloudflare.Containers.Workspace`) provides the
 * storage, the image and the machines.
 *
 * ### Declaring a workspace
 * **Example:** A workspace
 * ```typescript
 * // src/Workspace.ts
 * import * as Sandbox from "@alchemy.run/sandbox";
 *
 * export class Workspace extends Sandbox.Workspace<Workspace>()("Workspace") {}
 * ```
 *
 * ### Running commands in a session
 * `open` mounts the session's disk for as long as the effect runs and
 * snapshots it when the effect ends. Commands inside it can run in
 * parallel and see the same files.
 *
 * **Example:** Install, lint and test in one open
 * ```typescript
 * // src/Agent.ts
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Effect from "effect/Effect";
 * import { Workspace } from "./Workspace.ts";
 *
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const workspace = yield* Workspace;
 *     return Effect.gen(function* () {
 *       return {
 *         check: Effect.fn(function* (session: string) {
 *           return yield* workspace.open(
 *             session,
 *             {},
 *             Effect.gen(function* () {
 *               const box = yield* Workspace.Session;
 *               yield* Effect.all([box.exec("pnpm install"), box.exec("pnpm lint --fix")], {
 *                 concurrency: "unbounded",
 *               });
 *               return yield* box.exec("pnpm test");
 *             }),
 *           );
 *         }),
 *         rollback: Effect.fn(function* (session: string) {
 *           yield* workspace.undo(session);
 *         }),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * **Example:** One command
 * ```typescript
 * const output = yield* workspace.exec("issue-42", "git status");
 * ```
 *
 * @binding
 * @product Sandbox
 * @category Sandbox
 */
export const Workspace =
  <Self>() =>
  <const Id extends string>(id: Id): Workspace.Decl<Self, Id> => {
    const session = Context.Service<Workspace.Session<Self>, WorkspaceSession>(
      `alchemy/Sandbox/Workspace<${id}>/Session`,
    );
    const client = Effect.map(connect(id), (connection) => makeClient(connection, session));
    return Object.assign(
      class {},
      Effectable.Prototype({ label: `Sandbox.Workspace<${id}>`, evaluate: () => client }),
      {
        [WorkspaceTypeId]: WorkspaceTypeId,
        "~alchemy/Id": id,
        LogicalId: id,
        Session: session,
      },
    ) as unknown as Workspace.Decl<Self, Id>;
  };

export declare namespace Workspace {
  /** The service a host constructor's Layer provides for declaration `Self`. */
  export interface Host<Self> {
    readonly "~alchemy/WorkspaceHost": Self;
  }

  /** The open session inside `open`, for declaration `Self`. */
  export interface Session<Self> {
    readonly "~alchemy/WorkspaceSession": Self;
  }

  export interface Decl<Self = any, Id extends string = string>
    extends Effect.Effect<WorkspaceClient<Self>, never, Host<Self>>, Named<Id> {
    /** Branded with the id: two workspaces never satisfy each other's host or session. */
    new (_: never): WorkspaceClient<Self> & { readonly "~alchemy/WorkspaceId"?: Id };
    readonly [WorkspaceTypeId]: typeof WorkspaceTypeId;
    readonly LogicalId: Id;
    /** The session `open` provides: `yield* Workspace.Session` inside it. */
    readonly Session: Context.Service<Session<Self>, WorkspaceSession>;
  }
  export namespace Decl {
    export type Any = Decl<any, string>;
  }
}
