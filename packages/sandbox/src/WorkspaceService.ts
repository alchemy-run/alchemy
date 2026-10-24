/**
 * A workspace served over HTTP: the hosts of `AWS.Workspace` (and anything
 * else that serves this API) run the commands, and any runtime that can
 * make an HTTP request uses it. This module is the API's one definition:
 * its paths and bodies, and the client every platform's
 * `WorkspaceRuntime` returns for a service descriptor.
 *
 * ```text
 * POST /v1/exec            {session, command, cwd?, env?, timeoutMs?}  → {job}
 * GET  /v1/jobs/:job?wait=ms                                          → {done:false} | {done:true, result}
 * POST /v1/merge           {from, into}                               → {changes}
 * POST /v1/fork            {from, to}
 * POST /v1/undo            {session, steps}
 * POST /v1/history         {session, limit}                           → {history}
 * POST /v1/delete          {session}
 * POST /v1/opens           {session}                                  → {open, dir}
 * POST /v1/opens/:open/renew | /release
 * POST /v1/opens/:open/exec  {command, cwd?, env?, timeoutMs?}        → {job}
 * POST /v1/opens/:open/spawn {command, cwd?, env?}                    → {spawn, pid}
 * GET  /v1/spawns/:spawn?stream=out|err&offset=n                      → {data, exitCode}
 * POST /v1/spawns/:spawn/kill {signal}
 * ANY  /v1/opens/:open/ports/:port/*                                  → the port, proxied
 * ```
 *
 * Every request carries `authorization: Bearer <token>`. `data` is base64.
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { SandboxError, type SandboxPort, type SandboxProcess } from "./Sandbox.ts";
import {
  WorkspaceError,
  type WorkspaceChanges,
  type WorkspaceConnection,
  type WorkspaceExecOptions,
  type WorkspaceExecOutput,
  type WorkspaceExecResult,
  type WorkspaceSession,
} from "./Workspace.ts";

/** What a host binds for a workspace it serves over HTTP. */
export interface WorkspaceServiceDescriptor {
  readonly host: typeof WORKSPACE_SERVICE;
  readonly id: string;
  /** The service's base URL. */
  readonly url: string;
  /** The environment variable holding the service's token. */
  readonly tokenKey: string;
}

export const WORKSPACE_SERVICE = "alchemy-workspace-service" as const;

export const isServiceDescriptor = (
  descriptor: unknown,
): descriptor is WorkspaceServiceDescriptor =>
  typeof descriptor === "object" &&
  descriptor !== null &&
  (descriptor as { readonly host?: unknown }).host === WORKSPACE_SERVICE;

/** A command's options as the API takes them. */
export interface ServiceExecBody {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
}

/** A job's state as `GET /v1/jobs/:job` answers. */
export type ServiceJob<A> =
  | { readonly done: false }
  | { readonly done: true; readonly result: A }
  | { readonly done: true; readonly error: string };

/** How long one wait for a job holds its request. */
const WAIT = Duration.seconds(25);
/** How often a spawned process's output is polled. */
const POLL = Duration.millis(200);

const execBody = (command: string, options: WorkspaceExecOptions = {}): ServiceExecBody => ({
  command,
  ...(options.cwd ? { cwd: options.cwd } : {}),
  ...(options.env ? { env: options.env } : {}),
  ...(options.timeout !== undefined
    ? { timeoutMs: Duration.toMillis(Duration.fromInputUnsafe(options.timeout)) }
    : {}),
});

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A connection to a workspace service at `url`. */
export const connectWorkspaceService = (options: {
  readonly url: string;
  readonly token: Redacted.Redacted<string>;
}): WorkspaceConnection => {
  const base = options.url.replace(/\/$/, "");
  const fail = (path: string, message: string, cause?: unknown) =>
    new WorkspaceError({ message: `workspace service ${path}: ${message}`, cause });

  const send = <A>(
    request: HttpClientRequest.HttpClientRequest,
    path: string,
  ): Effect.Effect<A, WorkspaceError, RuntimeContext> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .execute(HttpClientRequest.bearerToken(request, Redacted.value(options.token)))
        .pipe(Effect.mapError((cause) => fail(path, cause.message, cause)));
      const text = yield* response.text.pipe(
        Effect.mapError((cause) => fail(path, cause.message, cause)),
      );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as { readonly error?: string },
        catch: (cause) => fail(path, `answered ${response.status}: ${text.slice(0, 500)}`, cause),
      });
      if (response.status !== 200) {
        return yield* fail(path, parsed.error ?? `status ${response.status}`);
      }
      return parsed as A;
    }).pipe(Effect.provide(FetchHttpClient.layer));

  const post = <A>(path: string, body: unknown = {}) =>
    send<A>(
      HttpClientRequest.post(`${base}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      path,
    );
  const get = <A>(path: string) => send<A>(HttpClientRequest.get(`${base}${path}`), path);

  /** Waits for a job in pieces: no request stays open for a long command. */
  const awaitJob = <A>(job: string) =>
    get<ServiceJob<A>>(`/v1/jobs/${job}?wait=${Duration.toMillis(WAIT)}`).pipe(
      // A wait that dropped (a proxy timing out, a restart) is waited again.
      Effect.retry({ schedule: Schedule.spaced(Duration.seconds(1)), times: 5 }),
      Effect.repeat({ until: (state) => state.done }),
      Effect.flatMap((state) =>
        "result" in state
          ? Effect.succeed(state.result)
          : "error" in state
            ? Effect.fail(fail(`/v1/jobs/${job}`, state.error))
            : Effect.fail(fail(`/v1/jobs/${job}`, "never finished")),
      ),
    );

  const spawned = (id: string, pid: number): SandboxProcess => {
    const toSandboxError = (error: WorkspaceError) =>
      new SandboxError({ message: error.message, cause: error });
    const read = (stream: "out" | "err", offset: number) =>
      get<{ readonly data: string; readonly exitCode: number | null }>(
        `/v1/spawns/${id}?stream=${stream}&offset=${offset}`,
      );
    const follow = (stream: "out" | "err") =>
      Stream.unfold({ offset: 0, done: false }, (cursor) =>
        cursor.done
          ? Effect.succeed(undefined)
          : read(stream, cursor.offset).pipe(
              Effect.flatMap((chunk) => {
                const data = fromBase64(chunk.data);
                return data.length === 0 && chunk.exitCode === null
                  ? Effect.as(Effect.sleep(POLL), [new Uint8Array(0), cursor] as const)
                  : Effect.succeed([
                      data,
                      {
                        offset: cursor.offset + data.length,
                        // Read once more after the exit: output written before it.
                        done: chunk.exitCode !== null && data.length === 0,
                      },
                    ] as const);
              }),
              Effect.mapError(toSandboxError),
            ),
      ).pipe(Stream.filter((chunk) => chunk.length > 0));
    const exitCode = read("out", Number.MAX_SAFE_INTEGER).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(POLL),
        until: (chunk) => chunk.exitCode !== null,
      }),
      Effect.map((chunk) => chunk.exitCode ?? 128),
      Effect.mapError(toSandboxError),
    );
    const collect = (stream: "out" | "err") =>
      Stream.runFold(
        follow(stream),
        () => new Uint8Array(0),
        (all, chunk) => {
          const next = new Uint8Array(all.length + chunk.length);
          next.set(all);
          next.set(chunk, all.length);
          return next;
        },
      );
    return {
      pid,
      isPty: false,
      stdin: undefined,
      stdout: follow("out"),
      stderr: follow("err"),
      exitCode,
      output: () =>
        Effect.gen(function* () {
          const [stdout, stderr] = yield* Effect.all([collect("out"), collect("err")], {
            concurrency: 2,
          });
          return {
            stdout: stdout.buffer as ArrayBuffer,
            stderr: stderr.buffer as ArrayBuffer,
            exitCode: yield* exitCode,
          };
        }),
      kill: (signal = 15) =>
        Effect.asVoid(post(`/v1/spawns/${id}/kill`, { signal })).pipe(
          Effect.mapError(toSandboxError),
        ),
      resize: () => Effect.void,
    } as unknown as SandboxProcess;
  };

  return {
    exec: (session, command, options = {}) =>
      Effect.flatMap(
        post<{ readonly job: string }>("/v1/exec", { session, ...execBody(command, options) }),
        ({ job }) => awaitJob<WorkspaceExecResult>(job),
      ),
    merge: (from, into) =>
      Effect.map(
        post<{ readonly changes: WorkspaceChanges }>("/v1/merge", { from, into }),
        (reply) => reply.changes,
      ),
    fork: (from, to) => Effect.asVoid(post("/v1/fork", { from, to })),
    undo: (session, steps = 1) => Effect.asVoid(post("/v1/undo", { session, steps })),
    history: (session, options = {}) =>
      Effect.map(
        post<{ readonly history: ReadonlyArray<string> }>("/v1/history", {
          session,
          limit: options.limit ?? 20,
        }),
        (reply) => reply.history,
      ),
    delete: (session) => Effect.asVoid(post("/v1/delete", { session })),
    acquire: (session, _options) =>
      Effect.gen(function* () {
        const opened = yield* Effect.acquireRelease(
          post<{ readonly open: string; readonly dir: string }>("/v1/opens", { session }),
          (held) => Effect.ignore(post(`/v1/opens/${held.open}/release`)),
        );
        // Keep the open alive for as long as its scope runs.
        yield* Effect.ignore(post(`/v1/opens/${opened.open}/renew`)).pipe(
          Effect.repeat(Schedule.spaced(Duration.seconds(30))),
          Effect.delay(Duration.seconds(30)),
          Effect.forkScoped,
        );
        const prefix = `/v1/opens/${opened.open}`;
        return {
          name: session,
          exec: (command, options) =>
            Effect.flatMap(
              post<{ readonly job: string }>(`${prefix}/exec`, execBody(command, options)),
              ({ job }) => awaitJob<WorkspaceExecOutput>(job),
            ),
          spawn: (command, options) =>
            Effect.gen(function* () {
              const started = yield* Effect.acquireRelease(
                post<{ readonly spawn: string; readonly pid: number }>(
                  `${prefix}/spawn`,
                  execBody(command, options),
                ),
                // Closing the scope kills the process.
                (process) =>
                  Effect.ignore(post(`/v1/spawns/${process.spawn}/kill`, { signal: 15 })),
              );
              return spawned(started.spawn, started.pid);
            }),
          port: (port) =>
            Effect.succeed({
              fetch: (request) =>
                Effect.gen(function* () {
                  const client = yield* HttpClient.HttpClient;
                  const url = new URL(request.url, "http://port");
                  return yield* client.execute(
                    HttpClientRequest.bearerToken(
                      HttpClientRequest.setUrl(
                        request,
                        `${base}${prefix}/ports/${port}${url.pathname}${url.search}`,
                      ),
                      Redacted.value(options.token),
                    ),
                  );
                }).pipe(Effect.provide(FetchHttpClient.layer)),
            } satisfies SandboxPort),
        } satisfies WorkspaceSession;
      }),
  };
};
