import type { Named } from "alchemy/Named";
import type * as Output from "alchemy/Output";
import { CurrentRuntimeContext, sanitizeKey, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import type { SandboxEgress, SandboxPort, SandboxProcess } from "./Sandbox.ts";
import { connectWorkspaceService, isServiceDescriptor } from "./WorkspaceService.ts";

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

/**
 * What happened to a command's changes (or a merge's). A command that ran
 * on a fork of the session lands in it only if nothing it changed was
 * changed in the session since the fork. Otherwise none of it lands: it's
 * kept as a session of its own, `fork`, to inspect, rerun or apply.
 */
export type WorkspaceChanges =
  | {
      readonly status: "applied";
      /** The session's snapshot with the changes in it, when one was taken. */
      readonly snapshot?: Snapshot;
      /** What changed. */
      readonly paths: ReadonlyArray<string>;
    }
  | {
      readonly status: "conflict";
      /** Paths both sides changed. */
      readonly paths: ReadonlyArray<string>;
      /** A session holding the refused changes on their base; absent for `merge`. */
      readonly fork?: string;
    };

/** A command run with `exec`: its output, and what happened to its changes. */
export interface WorkspaceExecResult extends WorkspaceExecOutput {
  readonly changes: WorkspaceChanges;
  /** Processes it left running in the workspace, if they were stopped. */
  readonly stopped?: ReadonlyArray<{ readonly pid: number; readonly command: string }>;
  /** Where the command's time went, when its host measures it. */
  readonly timings?: WorkspaceTimings;
}

/**
 * Milliseconds per phase of a command, in the order they ran: claiming a
 * machine, starting it, attaching and mounting the fork, running, making
 * and uploading the patch, landing it on the session's head. A phase's name
 * says who measured it: `blockd.*` on the machine, the rest by the host.
 */
export type WorkspaceTimings = Readonly<Record<string, number>>;

/**
 * The words to show a model for what happened to a command's changes and
 * processes, or `undefined` when there's nothing to say. Harness adapters
 * append it to the output a harness sees: a model is told, never left to
 * find the disk disagreeing with what it saw.
 */
export const describeChanges = (result: {
  readonly changes: WorkspaceChanges;
  readonly stopped?: WorkspaceExecResult["stopped"];
}): string | undefined => {
  const lines: Array<string> = [];
  if (result.changes.status === "conflict") {
    lines.push(
      "Not applied: other changes to these files landed since this command started:",
      ...result.changes.paths.map((path) => `  ${path}`),
      result.changes.fork
        ? `Nothing this command changed was applied. Its version is kept as session ${result.changes.fork}: inspect it, rerun the command, or apply it.`
        : "Nothing was applied.",
    );
  }
  const stopped = result.stopped ?? [];
  if (stopped.length > 0) {
    lines.push(
      `${stopped.length} background process${stopped.length === 1 ? " was" : "es were"} stopped when this command ended:`,
      ...stopped.map((process) => `  ${process.command || `pid ${process.pid}`}`),
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
};

/** What a workspace's changes mean, the same on every host. */
export interface WorkspaceOptions {
  /**
   * Paths where the newest change wins instead of conflicting: lockfiles,
   * build output, caches. Patterns are relative to the workspace: `*`
   * matches within a name, `**` across directories, and a pattern without
   * a `/` matches a name at any depth. `dist/**` matches `dist` too.
   */
  readonly lww?: ReadonlyArray<string>;
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
  /**
   * One command in `session`. Where it runs is the host's `placement`:
   * pinned, it's `open` around the command; serverless or automatic, it
   * runs on a fork of the session on any machine, and its changes merge
   * back (see {@link WorkspaceChanges}).
   */
  exec(
    session: string,
    command: string,
    options?: WorkspaceExecOptions & WorkspaceOpenOptions,
  ): Effect.Effect<WorkspaceExecResult, WorkspaceError, RuntimeContext>;
  /**
   * Merge what session `from` changed since it was forked into session
   * `into`, file by file. If both changed a file, nothing is merged and the
   * conflict names the files.
   */
  merge(
    from: string,
    into: string,
  ): Effect.Effect<WorkspaceChanges, WorkspaceError, RuntimeContext>;
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
  readonly exec: WorkspaceClient["exec"];
  readonly merge: WorkspaceClient["merge"];
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
  // A host that serves the workspace over HTTP works from any runtime.
  if (isServiceDescriptor(descriptor) || (Option.isSome(host) && runtime._tag === "None")) {
    if (!globalThis.__ALCHEMY_RUNTIME__ || !isServiceDescriptor(descriptor)) return atDeploy;
    const token = ctx ? yield* ctx.get<unknown>(descriptor.tokenKey) : undefined;
    return connectWorkspaceService({
      url: descriptor.url,
      token: Redacted.isRedacted(token)
        ? (token as Redacted.Redacted<string>)
        : Redacted.make(String(token ?? "")),
    });
  }
  if (Option.isNone(runtime)) {
    return yield* Effect.die(
      new WorkspaceError({
        message: `Workspace '${id}' can only be yielded inside a Worker or Durable Object.`,
      }),
    );
  }
  return yield* runtime.value.connect(id, descriptor);
});

/** At deploy a host's descriptor is an unresolved Output: nothing runs then. */
const atDeploy: WorkspaceConnection = {
  acquire: () => Effect.die(new Error("a workspace can't be opened at deploy")),
  exec: () => Effect.die(new Error("a workspace can't run commands at deploy")),
  merge: () => Effect.die(new Error("a workspace can't merge at deploy")),
  fork: () => Effect.die(new Error("a workspace can't be forked at deploy")),
  undo: () => Effect.die(new Error("a workspace can't be undone at deploy")),
  history: () => Effect.die(new Error("a workspace has no history at deploy")),
  delete: () => Effect.die(new Error("a workspace can't be deleted at deploy")),
};

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
  exec: connection.exec,
  merge: connection.merge,
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
 * ### Commands that merge back
 * When the host runs `exec` on forks (`placement: "serverless"` on
 * `Cloudflare.Containers.Workspace`), each command's result says what
 * happened to its changes. `lww` names paths where the newest change wins
 * instead of conflicting. `describeChanges` puts it in words for a model.
 *
 * **Example:** Tell the model when a command's changes didn't land
 * ```typescript
 * // src/Workspace.ts
 * import * as Sandbox from "@alchemy.run/sandbox";
 *
 * export class Workspace extends Sandbox.Workspace<Workspace>()("Workspace", {
 *   lww: ["pnpm-lock.yaml", "dist/**", "node_modules/.cache/**"],
 * }) {}
 * ```
 * ```typescript
 * // src/Agent.ts
 * const result = yield* workspace.exec(session, command);
 * const notice = Sandbox.describeChanges(result);
 * return notice ? `${result.stdout}\n${notice}` : result.stdout;
 * ```
 *
 * ### Merging forks
 * **Example:** Try something on a fork, then keep it
 * ```typescript
 * yield* workspace.fork("issue-42", "issue-42-try");
 * yield* workspace.exec("issue-42-try", "pnpm up --latest");
 * const merged = yield* workspace.merge("issue-42-try", "issue-42");
 * if (merged.status === "conflict") console.log("both changed", merged.paths);
 * ```
 *
 * @binding
 * @product Sandbox
 * @category Sandbox
 */
export const Workspace =
  <Self>() =>
  <const Id extends string>(id: Id, options: WorkspaceOptions = {}): Workspace.Decl<Self, Id> => {
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
        Options: options,
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
    readonly Options: WorkspaceOptions;
  }
  export namespace Decl {
    export type Any = Decl<any, string>;
  }
}
