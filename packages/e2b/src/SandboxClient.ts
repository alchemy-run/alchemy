import type * as E2B from "@distilled.cloud/e2b";
import type * as envd from "@distilled.cloud/e2b/envd";
import type * as filesystem from "@distilled.cloud/e2b/filesystem";
import type * as process from "@distilled.cloud/e2b/process";
import type * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import type * as templates from "@distilled.cloud/e2b/templates";
import type * as volumes from "@distilled.cloud/e2b/volumes";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Sandbox from "alchemy/Sandbox";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { E2BUnexpectedResponse, ExecTimedOut, SandboxBaseMissing } from "./Errors.ts";

/** Errors an E2B call can fail with. */
export type E2BError =
  | E2B.E2BOpError
  | templates.TemplateInUse
  | volumes.VolumesNotEnabled
  | process.ConnectStreamError
  | process.SandboxNotRunning
  | filesystem.SandboxNotRunning
  | envd.SandboxNotRunning
  | SandboxBaseMissing
  | ExecTimedOut
  | E2BUnexpectedResponse;

/** A process inside a sandbox, by pid or by the tag it was started with. */
export type ProcessSelector = process.ConnectProcessRequest["process"];

/** An event from a watched directory. */
export type WatchEvent = filesystem.WatchDirEvent;

/** A file or directory inside a sandbox. */
export type EntryInfo = filesystem.EntryInfo;

/** A running process inside a sandbox, as `processes.list()` reports it. */
export type ProcessInfo = process.ProcessInfo;

/**
 * A command: a shell command line (run with `bash -l -c`), or an argument
 * vector run directly.
 */
export type Command = Sandbox.Command;

/**
 * `cwd` defaults to the sandbox user's home; `timeout` kills the command and
 * fails with `ExecTimedOut`.
 */
export type ExecOptions = Sandbox.ExecOptions;

/** What a finished command printed, and its exit code. A non-zero exit code is returned, not failed. */
export interface ExecResult extends Sandbox.ExecResult {
  readonly pid: number;
  /** envd's error for a process that could not run (e.g. the executable is missing). */
  readonly error: string | undefined;
}

export interface StartOptions {
  /** Working directory. @default the sandbox user's home */
  readonly cwd?: string;
  /** Environment variables for the command. */
  readonly env?: Readonly<Record<string, string>>;
  /** A tag to find the process by with `processes.attach({ tag })`. */
  readonly tag?: string;
  /** Keep stdin open for `write`. @default false */
  readonly stdin?: boolean;
}

/** A chunk of a process's output. */
export type ProcessOutput = Sandbox.ProcessOutput;

/**
 * A process started (or attached to) in the current scope. Closing the
 * scope detaches: the process keeps running until it exits or is killed.
 * `id` is its pid as a string.
 */
export interface Process extends Sandbox.Process<E2BError> {
  readonly pid: number;
  /** stdout and stderr, from now until the process exits. Read it once. */
  readonly output: Stream.Stream<ProcessOutput, E2BError>;
  /** Writes to stdin (the process must have been started with `stdin: true`). */
  write(data: string | Uint8Array): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Closes stdin. */
  closeStdin(): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Signals the process. @default "SIGKILL" */
  kill(signal?: "SIGTERM" | "SIGKILL"): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Waits for the process to exit, with everything it printed since it was started or attached. */
  readonly wait: Effect.Effect<ExecResult, E2BError>;
}

/** The processes running in the sandbox. */
export interface Processes {
  list(): Effect.Effect<ReadonlyArray<ProcessInfo>, E2BError, RuntimeContext>;
  /** Re-attaches to a running process, by pid or tag; output streams from now on. */
  attach(process: ProcessSelector): Effect.Effect<Process, E2BError, RuntimeContext | Scope.Scope>;
}

export interface PtyOptions extends Sandbox.PtyOptions {
  /** A tag to find the terminal's process by. */
  readonly tag?: string;
}

/** A pseudo-terminal opened in the current scope. Closing the scope detaches. `id` is its pid as a string. */
export interface PtyConnection extends Sandbox.PtyConnection<E2BError> {
  readonly pid: number;
  /** The terminal's output. Read it once. */
  readonly output: Stream.Stream<Uint8Array, E2BError>;
  /** Types into the terminal. */
  write(data: string | Uint8Array): Effect.Effect<void, E2BError, RuntimeContext>;
  resize(size: {
    readonly cols: number;
    readonly rows: number;
  }): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Kills the terminal's process. */
  kill(): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Waits for the terminal's process to exit. */
  readonly wait: Effect.Effect<{ readonly exitCode: number }, E2BError>;
}

/** Pseudo-terminals inside the sandbox. */
export interface Pty extends Sandbox.Pty<E2BError, PtyOptions> {
  open(options: PtyOptions): Effect.Effect<PtyConnection, E2BError, RuntimeContext | Scope.Scope>;
}

/** The sandbox's filesystem, through envd. Relative paths resolve in the user's home. */
export interface Files extends Sandbox.Files<E2BError, EntryInfo> {
  read(path: string): Effect.Effect<Uint8Array, E2BError, RuntimeContext>;
  readText(path: string): Effect.Effect<string, E2BError, RuntimeContext>;
  /** Writes a file, creating parent directories. */
  write(path: string, data: string | Uint8Array): Effect.Effect<void, E2BError, RuntimeContext>;
  list(
    path: string,
    options?: { readonly depth?: number },
  ): Effect.Effect<ReadonlyArray<EntryInfo>, E2BError, RuntimeContext>;
  stat(path: string): Effect.Effect<EntryInfo, E2BError, RuntimeContext>;
  remove(path: string): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Creates the directory and its parents. */
  makeDir(path: string): Effect.Effect<void, E2BError, RuntimeContext>;
  exists(path: string): Effect.Effect<boolean, E2BError, RuntimeContext>;
  move(source: string, destination: string): Effect.Effect<EntryInfo, E2BError, RuntimeContext>;
  /** Concatenates files into `destination`. */
  compose(
    sources: ReadonlyArray<string>,
    destination: string,
  ): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Streams changes under a directory until interrupted. */
  watch(
    path: string,
    options?: { readonly recursive?: boolean; readonly includeEntry?: boolean },
  ): Stream.Stream<WatchEvent, E2BError, RuntimeContext>;
}

/** One fork's outcome: the new sandbox, or why it could not start. */
export type ForkResult =
  | { readonly _tag: "Forked"; readonly sandbox: E2BSandbox }
  | { readonly _tag: "ForkFailed"; readonly code: number | undefined; readonly message: string };

/** Network rules for a running sandbox (`updateSandboxNetwork`), in E2B's shape. */
export type SandboxNetworkUpdate = Omit<sandboxes.UpdateSandboxNetworkRequest, "sandboxID">;

/**
 * A port inside an E2B sandbox, served at `https://<port>-<sandboxId>.<domain>`.
 * `fetch` sends a client request to it, or proxies a server request there.
 */
export interface Port extends Sandbox.SandboxPort<E2BError> {
  /** The host E2B serves the port on: `<port>-<sandboxId>.<domain>`. */
  readonly host: string;
  /** `https://<host>`. Public unless the sandbox requires its traffic token. */
  readonly url: string;
}

/**
 * What you can do with a sandbox, however you got it. Calls that reach
 * inside a paused sandbox (`exec`, `start`, `files`, `pty`) fail with
 * `SandboxNotRunning`: `resume()` it first. A sandbox created with
 * `autoResume` is the exception: E2B resumes it on any request.
 */
export interface SandboxOperations
  extends
    Sandbox.SandboxExec<E2BError, ExecResult, ExecOptions>,
    Sandbox.SandboxProcesses<E2BError, StartOptions>,
    Sandbox.SandboxFiles<E2BError, EntryInfo>,
    Sandbox.SandboxPty<E2BError, PtyOptions>,
    Sandbox.SandboxPorts<E2BError, Port> {
  /** Runs a command to completion. */
  exec(
    command: Command,
    options?: ExecOptions,
  ): Effect.Effect<ExecResult, E2BError, RuntimeContext>;
  /** Starts a command in the current scope. */
  start(
    command: Command,
    options?: StartOptions,
  ): Effect.Effect<Process, E2BError, RuntimeContext | Scope.Scope>;
  readonly processes: Processes;
  readonly files: Files;
  readonly pty: Pty;
  /**
   * A port inside the sandbox. Its `fetch` adds the sandbox's traffic token
   * when the sandbox's URLs are not public.
   */
  getTcpPort(port: number): Effect.Effect<Port, E2BError, RuntimeContext>;
  /** Live details: state, resources, network, metadata. */
  describe(): Effect.Effect<sandboxes.SandboxDetail, E2BError, RuntimeContext>;
  /** Pauses the sandbox, keeping its memory and files. */
  pause(): Effect.Effect<void, E2BError, RuntimeContext>;
  /**
   * Resumes a paused sandbox (a no-op on a running one). `timeout` sets how
   * long it runs before it is paused or killed again.
   */
  resume(options?: {
    readonly timeout?: Duration.Input;
  }): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Kills the sandbox. Killing one that is gone succeeds. */
  kill(): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Sets the time left before the sandbox is killed (or paused, with `autoPause`). */
  setTimeout(timeout: Duration.Input): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Extends the sandbox's lifetime by `duration`. */
  refresh(duration?: Duration.Input): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Replaces the sandbox's egress rules (E2B's `updateSandboxNetwork`). */
  updateNetwork(network: SandboxNetworkUpdate): Effect.Effect<void, E2BError, RuntimeContext>;
  /**
   * Snapshots the sandbox into a named template (memory and disk by
   * default). Sandboxes created from it start where this one is now.
   */
  snapshot(options?: {
    readonly name?: string;
    readonly memory?: boolean;
  }): Effect.Effect<sandboxes.SnapshotInfo, E2BError, RuntimeContext>;
  /**
   * Checkpoints the sandbox (it keeps running) and starts `count` copies of
   * it. Each fork succeeds or fails on its own.
   */
  fork(options?: {
    readonly count?: number;
    readonly timeout?: Duration.Input;
  }): Effect.Effect<ReadonlyArray<ForkResult>, E2BError, RuntimeContext>;
  /** CPU, memory and disk metrics. */
  metrics(): Effect.Effect<ReadonlyArray<sandboxes.SandboxMetric>, E2BError, RuntimeContext>;
  /** The sandbox's logs. */
  logs(
    options?: Omit<sandboxes.ListSandboxLogsRequest, "sandboxID">,
  ): Effect.Effect<sandboxes.SandboxLogsV2Response, E2BError, RuntimeContext>;
}

/**
 * A sandbox created or connected at runtime (`CreateSandbox`). Holds only
 * ids and tokens, so it can be rebuilt from its id with `connect(id)` in
 * any request.
 */
export interface E2BSandbox extends SandboxOperations {
  readonly sandboxId: string;
  readonly templateId: string;
  /** The domain the sandbox's ports are served under (`<port>-<sandboxId>.<domain>`). */
  readonly domain: string;
  /** What E2B returned for the sandbox when it was created or connected. */
  readonly info: sandboxes.Sandbox;
}

/**
 * A sandbox declared in the stack (`ConnectSandbox`). The same operations
 * as {@link E2BSandbox}; its id is read at runtime.
 */
export interface ConnectedSandbox extends SandboxOperations {
  readonly sandboxId: Effect.Effect<string, never, RuntimeContext>;
}
