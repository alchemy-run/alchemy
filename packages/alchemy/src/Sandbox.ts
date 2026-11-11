import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { RuntimeContext } from "./RuntimeContext.ts";

/**
 * The names a sandbox handle uses for what every sandbox platform does: run
 * a command, stream a process, use files, open a terminal, call a port. A
 * provider's handle (`E2B`, `Daytona`, `Modal`, `Archil`, `AWS.ECS`) extends the parts
 * its platform supports and adds the platform's own calls next to them
 * (lifecycle, snapshots, forks, network policy).
 *
 * These are names and shapes, not an abstraction over sandboxes: each
 * provider fills in its own errors, options and results.
 */

/** A command: a shell line (run with the platform's shell) or an argument vector (no shell). */
export type Command = string | readonly [string, ...string[]];

/** Options every platform's `exec` and `start` take. */
export interface ExecOptions {
  /** Working directory. */
  readonly cwd?: string;
  /** Extra environment variables. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kill the command after this long. */
  readonly timeout?: Duration.Input;
  /** Written to the command's stdin, which is then closed. */
  readonly stdin?: string | Uint8Array;
}

/** A finished command. A non-zero exit code is returned, not failed. */
export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a command to completion. */
export interface SandboxExec<E, Result = ExecResult, Options = ExecOptions> {
  exec(command: Command, options?: Options): Effect.Effect<Result, E, RuntimeContext>;
}

/** A piece of a process's output. Platforms that combine the streams report `stdout`. */
export interface ProcessOutput {
  readonly fd: "stdout" | "stderr";
  readonly data: Uint8Array;
}

/** A started process. Closing its scope detaches; the process keeps running. */
export interface Process<E> {
  /** The platform's id for the process, to re-attach to it later. */
  readonly id: string;
  /** Its output from now until it exits. */
  readonly output: Stream.Stream<ProcessOutput, E, RuntimeContext>;
  /** Writes to its stdin. */
  write(data: string | Uint8Array): Effect.Effect<void, E, RuntimeContext>;
  /** Signals it. */
  kill(signal?: "SIGTERM" | "SIGKILL"): Effect.Effect<void, E, RuntimeContext>;
  /** Waits for it to exit. */
  readonly wait: Effect.Effect<{ readonly exitCode: number }, E, RuntimeContext>;
}

/** Start a process and stream it. */
export interface SandboxProcesses<E, Options = ExecOptions> {
  start(
    command: Command,
    options?: Options,
  ): Effect.Effect<Process<E>, E, RuntimeContext | Scope.Scope>;
}

/** A file or directory, as the platform reports it. */
export interface FileEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size?: number;
}

/** The sandbox's filesystem. */
export interface Files<E, Entry = FileEntry> {
  read(path: string): Effect.Effect<Uint8Array, E, RuntimeContext>;
  readText(path: string): Effect.Effect<string, E, RuntimeContext>;
  /** Creates or truncates the file, and its parent directories. */
  write(path: string, data: string | Uint8Array): Effect.Effect<void, E, RuntimeContext>;
  list(path: string): Effect.Effect<ReadonlyArray<Entry>, E, RuntimeContext>;
  stat(path: string): Effect.Effect<Entry, E, RuntimeContext>;
  remove(path: string): Effect.Effect<void, E, RuntimeContext>;
  /** Creates the directory and its parents. */
  makeDir(path: string): Effect.Effect<void, E, RuntimeContext>;
}

/** `files` on a handle. */
export interface SandboxFiles<E, Entry = FileEntry> {
  readonly files: Files<E, Entry>;
}

/** Options for opening a terminal. */
export interface PtyOptions {
  readonly cols: number;
  readonly rows: number;
  /** Runs this instead of a login shell. */
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** An open terminal. Closing its scope disconnects; the session may keep running. */
export interface PtyConnection<E> {
  /** The platform's id for the session, to reconnect to it later. */
  readonly id: string;
  readonly output: Stream.Stream<Uint8Array, E, RuntimeContext>;
  /** Types into the terminal. */
  write(data: string | Uint8Array): Effect.Effect<void, E, RuntimeContext>;
  resize(size: {
    readonly cols: number;
    readonly rows: number;
  }): Effect.Effect<void, E, RuntimeContext>;
}

/** Terminals. */
export interface Pty<E, Options = PtyOptions> {
  open(options: Options): Effect.Effect<PtyConnection<E>, E, RuntimeContext | Scope.Scope>;
}

/** `pty` on a handle. */
export interface SandboxPty<E, Options = PtyOptions> {
  readonly pty: Pty<E, Options>;
}

/**
 * A port inside the sandbox. `fetch` keeps the request's method, path, query,
 * headers and body, and sends it to the port. Give it a client request to
 * call the port, or the server request a handler received to proxy it there
 * (a Cloudflare Worker in front of a sandbox), and get the matching response
 * back. Bodies stream both ways.
 *
 * Providers widen it with what their platform has for a port (a public
 * `url`, a preview token, a TCP `connect`).
 */
export interface SandboxPort<E> {
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    E | HttpClientError.HttpClientError,
    RuntimeContext
  >;
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E | HttpClientError.HttpClientError,
    RuntimeContext
  >;
}

/** `getTcpPort` on a handle, named as on Cloudflare Containers. */
export interface SandboxPorts<E, Port extends SandboxPort<E> = SandboxPort<E>> {
  getTcpPort(port: number): Effect.Effect<Port, E, RuntimeContext>;
}

/**
 * Builds a {@link SandboxPort}'s `fetch` from a provider's client call, so
 * proxying a server request works the same on every platform: the server
 * request becomes a client request with its body streamed, and the response
 * streams back as a server response.
 */
export const portFetch = <E>(
  send: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    E | HttpClientError.HttpClientError,
    RuntimeContext
  >,
): SandboxPort<E>["fetch"] =>
  ((request: HttpClientRequest.HttpClientRequest | HttpServerRequest.HttpServerRequest) =>
    HttpClientRequest.isHttpClientRequest(request)
      ? send(request)
      : Effect.map(
          send(HttpServerRequest.toClientRequest(request)),
          HttpServerResponse.fromClientResponse,
        )) as SandboxPort<E>["fetch"];
