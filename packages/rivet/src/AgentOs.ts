/**
 * agentOS on Rivet: a computer for every agent, exposed as Alchemy's
 * standard Sandbox shapes (`exec`, `files`, `start`, `pty`, ports) over the
 * Rivet Services pool that already hosts the agentOS actor.
 *
 * {@link AgentOs} resolves the control plane endpoint, token and namespace
 * from {@link Services}, builds a RivetKit client against {@link SERVICES_POOL},
 * and returns handles that speak `alchemy/Sandbox`.
 *
 * @see https://rivet.dev/docs/agent-os
 */
import {
  createAgentOsClient,
  type AgentOsActorHandle,
  type AgentOsCreateOptions,
  type AgentOsGetOrCreateOptions,
} from "@rivet-dev/agentos";
import * as Output from "alchemy/Output";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Services, SERVICES_POOL } from "./Services.ts";

/** A client was built outside any runtime that has {@link Services}. */
export class AgentOsCalledOutsideRuntime extends Data.TaggedError(
  "Rivet.AgentOsCalledOutsideRuntime",
)<{
  readonly message: string;
}> {}

/** The control plane couldn't be reached, or agentOS answered with an error. */
export class AgentOsRequestError extends Data.TaggedError("Rivet.AgentOsRequestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AgentOsError = AgentOsRequestError | HttpClientError.HttpClientError;

/** Options for `exec` / `start`: Alchemy's shared shape. */
export type ExecOptions = Sandbox.ExecOptions;

/** A finished command. A non-zero exit code is returned, not failed. */
export type ExecResult = Sandbox.ExecResult;

/** A file or directory entry from agentOS. */
export interface FileEntry extends Sandbox.FileEntry {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly mode: number;
  readonly mtimeMs?: number;
}

/** Resolve Services binding values the same way Durable Streams do. */
const resolveTarget = Effect.gen(function* () {
  const services = yield* Services;
  const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
  if (ctx === undefined) {
    return yield* Effect.die(
      new AgentOsCalledOutsideRuntime({
        message: "Rivet.AgentOs can only be used inside a runtime that has Rivet.Services.",
      }),
    );
  }
  const bind = <T>(key: string, value: unknown) =>
    ctx
      .set(
        sanitizeKey(`RIVET_SERVICES_${key}`),
        Output.isOutput(value) ? value : Output.literal(value),
      )
      .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
  const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", services.token);
  return {
    endpoint: (yield* bind<string>("ENDPOINT", services.endpoint)) ?? "",
    namespace: (yield* bind<string>("NAMESPACE", services.namespace)) ?? "",
    token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
  };
});

const promise = <A>(run: () => Promise<A>): Effect.Effect<A, AgentOsRequestError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new AgentOsRequestError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

/** Split Alchemy's `Command` into agentOS `command` + `args`. */
export const commandParts = (
  command: Sandbox.Command,
): { readonly command: string; readonly args?: ReadonlyArray<string> } =>
  typeof command === "string"
    ? { command: "sh", args: ["-c", command] }
    : { command: command[0]!, args: command.slice(1) };

const timeoutMs = (timeout: Duration.Input | undefined): number | undefined =>
  timeout === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(timeout));

const keyId = (key?: string | ReadonlyArray<string>) =>
  key === undefined ? "default" : typeof key === "string" ? key : key.join("/");

type OutputEvent = {
  readonly stream?: "stdout" | "stderr";
  readonly data: Uint8Array;
};

/** Poll process or terminal output pages into a Stream. */
const outputPages = <A, E>(
  read: (after: number | bigint | null | undefined) => Effect.Effect<
    {
      readonly events: ReadonlyArray<OutputEvent>;
      readonly nextCursor?: number | bigint | null;
      readonly end?: { readonly exitCode: number } | null;
    },
    E
  >,
  mapEvent: (event: OutputEvent) => A,
): Stream.Stream<A, E> =>
  Stream.paginate(undefined as number | bigint | null | undefined, (after) =>
    read(after).pipe(
      Effect.map((page) => {
        const chunk = page.events.map(mapEvent);
        const done = page.end !== null && page.end !== undefined;
        const next =
          done || (page.nextCursor === null && page.events.length === 0)
            ? Option.none<number | bigint | null | undefined>()
            : Option.some(page.nextCursor ?? after);
        return [chunk, next] as const;
      }),
    ),
  );

/** Build a Sandbox-shaped handle over one agentOS actor. */
const sandboxOf = (handle: AgentOsActorHandle, id: string): AgentOsSandbox => {
  const v1 = handle.v1;
  const generations = new Map<string, number | bigint>();

  const exec = (command: Sandbox.Command, options?: ExecOptions) => {
    const parts = commandParts(command);
    return promise(() =>
      v1.process.run({
        command: parts.command,
        ...(parts.args === undefined || parts.args.length === 0 ? {} : { args: [...parts.args] }),
        options: {
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.env === undefined ? {} : { env: options.env }),
          ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
          ...(options?.timeout === undefined ? {} : { timeoutMs: timeoutMs(options.timeout) }),
          captureStdio: true,
        },
      }),
    ).pipe(
      Effect.map((result): ExecResult => ({
        exitCode: result.status.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      })),
    );
  };

  const files: Sandbox.Files<AgentOsError, FileEntry> = {
    read: (path) => promise(() => v1.filesystem.readFile({ path })),
    readText: (path) =>
      promise(() => v1.filesystem.readFile({ path })).pipe(
        Effect.map((bytes) => new TextDecoder().decode(bytes)),
      ),
    write: (path, data) =>
      promise(() => v1.filesystem.writeFile({ path, content: data })).pipe(Effect.asVoid),
    list: (path) =>
      promise(() => v1.filesystem.readdirEntries({ path })).pipe(
        Effect.map((entries) =>
          entries.map((entry): FileEntry => ({
            path: `${path.replace(/\/$/, "")}/${entry.name}`,
            type: entry.isDirectory ? "directory" : entry.isSymbolicLink ? "symlink" : "file",
            isDirectory: entry.isDirectory,
            isSymbolicLink: entry.isSymbolicLink,
            mode: 0,
          })),
        ),
      ),
    stat: (path) =>
      promise(() => v1.filesystem.stat({ path })).pipe(
        Effect.map((stat): FileEntry => ({
          path,
          type: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
          size: Number(stat.sizeBytes),
          isDirectory: stat.isDirectory,
          isSymbolicLink: stat.isSymbolicLink,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
        })),
      ),
    remove: (path) => promise(() => v1.filesystem.remove({ path })).pipe(Effect.asVoid),
    makeDir: (path) => promise(() => v1.filesystem.mkdir({ path })).pipe(Effect.asVoid),
  };

  const start = (
    command: Sandbox.Command,
    options?: ExecOptions,
  ): Effect.Effect<Sandbox.Process<AgentOsError>, AgentOsError, RuntimeContext | Scope.Scope> => {
    const parts = commandParts(command);
    return Effect.gen(function* () {
      const spawned = yield* promise(() =>
        v1.process.spawn({
          command: parts.command,
          ...(parts.args === undefined || parts.args.length === 0 ? {} : { args: [...parts.args] }),
          options: {
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options?.env === undefined ? {} : { env: options.env }),
            openStdin: true,
          },
        }),
      );
      const processId = { generation: spawned.generation, pid: spawned.pid };
      if (options?.stdin !== undefined) {
        yield* promise(() => v1.process.stdin.write({ process: processId, data: options.stdin! }));
        yield* promise(() => v1.process.stdin.close({ process: processId }));
      }
      return {
        id: `${String(spawned.generation)}:${spawned.pid}`,
        output: outputPages(
          (after) =>
            promise(() =>
              v1.process.output.read({
                process: processId,
                after,
                maxEvents: 64,
              }),
            ),
          (event) => ({
            fd: event.stream ?? "stdout",
            data: event.data,
          }),
        ),
        write: (data) =>
          promise(() => v1.process.stdin.write({ process: processId, data })).pipe(Effect.asVoid),
        kill: (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") =>
          promise(() => v1.process.signal({ process: processId, signal })).pipe(Effect.asVoid),
        wait: promise(() => v1.process.wait({ process: processId })).pipe(
          Effect.map((result) => ({ exitCode: result.status.exitCode })),
        ),
      } satisfies Sandbox.Process<AgentOsError>;
    });
  };

  const pty: Sandbox.Pty<AgentOsError> = {
    open: (options) =>
      Effect.acquireRelease(
        promise(() =>
          v1.terminal.open({
            options: {
              cols: options.cols,
              rows: options.rows,
              ...(options.command === undefined ? {} : { command: options.command }),
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env }),
            },
          }),
        ).pipe(
          Effect.map((opened) => {
            generations.set(opened.shellId, opened.generation);
            const terminal = { generation: opened.generation, shellId: opened.shellId };
            return {
              id: opened.shellId,
              output: outputPages(
                (after) =>
                  promise(() =>
                    v1.terminal.output.read({
                      terminal,
                      after,
                      maxEvents: 64,
                    }),
                  ),
                (event) => event.data,
              ),
              write: (data: string | Uint8Array) =>
                promise(() => v1.terminal.stdin.write({ terminal, data })).pipe(Effect.asVoid),
              resize: (size: { readonly cols: number; readonly rows: number }) =>
                promise(() =>
                  v1.terminal.pty.resize({
                    terminal,
                    cols: size.cols,
                    rows: size.rows,
                  }),
                ).pipe(Effect.asVoid),
            } satisfies Sandbox.PtyConnection<AgentOsError>;
          }),
        ),
        (connection) => {
          const generation = generations.get(connection.id);
          if (generation === undefined) return Effect.void;
          generations.delete(connection.id);
          return promise(() =>
            v1.terminal.close({ terminal: { generation, shellId: connection.id } }),
          ).pipe(Effect.ignore);
        },
      ),
  };

  const getTcpPort = (port: number) =>
    promise(() => v1.network.preview.create({ port })).pipe(
      Effect.map((preview) => ({
        port,
        preview: {
          token: preview.token,
          path: preview.path,
          expiresAtMs: Number(preview.expiresAtMs),
        },
        fetch: Sandbox.portFetch<AgentOsError>((request) => {
          const url = new URL(request.url, "http://sandbox");
          const headers = Object.fromEntries(Object.entries(request.headers));
          return promise(() =>
            v1.network.fetch({
              request: {
                port,
                path: `${url.pathname}${url.search}`,
                method: request.method,
                headers,
              },
            }),
          ).pipe(
            Effect.map((result) =>
              HttpClientResponse.fromWeb(
                request,
                new Response(result.body.slice(), {
                  status: result.status,
                  statusText: result.statusText,
                  headers: result.headers,
                }),
              ),
            ),
          );
        }),
      })),
    );

  return {
    id,
    handle,
    exec,
    start,
    files,
    pty,
    getTcpPort,
  };
};

/**
 * One agentOS computer: Alchemy Sandbox shapes over the hosted actor.
 * `handle` is the raw RivetKit actor for APIs Sandbox does not cover
 * (JavaScript/Python/TypeScript eval, software install, VM status, …).
 */
export interface AgentOsSandbox
  extends
    Sandbox.SandboxExec<AgentOsError, ExecResult, ExecOptions>,
    Sandbox.SandboxProcesses<AgentOsError, ExecOptions>,
    Sandbox.SandboxFiles<AgentOsError, FileEntry>,
    Sandbox.SandboxPty<AgentOsError>,
    Sandbox.SandboxPorts<AgentOsError> {
  /** The actor key this sandbox was opened with. */
  readonly id: string;
  /** The underlying RivetKit agentOS handle. */
  readonly handle: AgentOsActorHandle;
}

/** Create, look up and connect agentOS computers on the Services pool. */
export interface AgentOsClient {
  /**
   * Create a new agentOS actor (fails if the key already exists).
   * Returns a Sandbox-shaped handle.
   */
  create(
    key?: string | ReadonlyArray<string>,
    options?: AgentOsCreateOptions,
  ): Effect.Effect<AgentOsSandbox, AgentOsError, RuntimeContext>;
  /** Get or create an agentOS actor by key. */
  getOrCreate(
    key?: string | ReadonlyArray<string>,
    options?: AgentOsGetOrCreateOptions,
  ): Effect.Effect<AgentOsSandbox, AgentOsError, RuntimeContext>;
  /** A handle to an existing actor by Rivet actor id. */
  getForId(actorId: string): Effect.Effect<AgentOsSandbox, AgentOsError, RuntimeContext>;
}

/**
 * A typed agentOS client for the Rivet Services pool. Resolves the control
 * plane from {@link Services} and targets {@link SERVICES_POOL}. Use from any
 * runtime that was given a services pool Layer.
 *
 * ### Using agentOS as a Sandbox
 * **Example:** Run a command in a per-session computer
 * ```typescript
 * const agentOs = yield* Rivet.AgentOs;
 * const sandbox = yield* agentOs.getOrCreate("session-1");
 * const result = yield* sandbox.exec("uname -a");
 * yield* sandbox.files.write("/tmp/hello.txt", "hi");
 * ```
 *
 * **Example:** Stream a long process
 * ```typescript
 * const build = yield* sandbox.start(["npm", "run", "build"], { cwd: "/home/agent" });
 * yield* build.output.pipe(
 *   Stream.runForEach((chunk) => Effect.log(new TextDecoder().decode(chunk.data))),
 * );
 * const { exitCode } = yield* build.wait;
 * ```
 */
export const AgentOs: Effect.Effect<AgentOsClient, never, Services | RuntimeContext> = Effect.gen(
  function* () {
    const target = yield* resolveTarget;
    const client = createAgentOsClient({
      endpoint: target.endpoint,
      token: target.token,
      namespace: target.namespace,
      poolName: SERVICES_POOL,
    });
    return {
      create: (key, options) =>
        promise(() => client.agentOS.create(key as string | string[] | undefined, options)).pipe(
          Effect.map((handle) => sandboxOf(handle, keyId(key))),
        ),
      getOrCreate: (key, options) =>
        Effect.sync(() =>
          sandboxOf(
            client.agentOS.getOrCreate(key as string | string[] | undefined, options),
            keyId(key),
          ),
        ),
      getForId: (actorId) =>
        Effect.sync(() => sandboxOf(client.getForId("agentOS", actorId), actorId)),
    } satisfies AgentOsClient;
  },
);
