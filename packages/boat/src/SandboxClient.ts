import type * as Boat from "@distilled.cloud/boat-dev";
import type * as boat from "@distilled.cloud/boat-dev/boat";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Sandbox from "alchemy/Sandbox";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type { BoatUnexpectedResponse, ExecTimedOut, SnapshotFailed } from "./Errors.ts";

/** Errors a Boat call can fail with. */
export type BoatError =
  | Boat.BoatOpError
  | boat.BadRequest
  | boat.Forbidden
  | boat.NotFound
  | boat.Conflict
  | boat.SandboxNotRunning
  | boat.SandboxStartLimitExceeded
  | boat.FileNotFound
  | boat.ForkNeedsSnapshot
  | boat.SaveInProgress
  | ExecTimedOut
  | SnapshotFailed
  | BoatUnexpectedResponse;

/** A command: a shell line (run with `bash -lc`) or an argument vector. */
export type Command = Sandbox.Command;

/**
 * `cwd` defaults to the home directory (`/home/user`). `timeout` (at most
 * 10 minutes, Boat's default 30 seconds) stops the command and fails with
 * `Boat.ExecTimedOut`.
 */
export type ExecOptions = Sandbox.ExecOptions;

/** What a finished command printed, and its exit code. A non-zero exit code is returned, not failed. */
export interface ExecResult extends Sandbox.ExecResult {
  /** Boat's id for the command, for its history and logs. */
  readonly commandId: string | undefined;
}

export interface StartOptions {
  /** Working directory. @default "/home/user" */
  readonly cwd?: string;
  /** Environment variables for the command. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A chunk of a process's output. */
export type ProcessOutput = Sandbox.ProcessOutput;

/**
 * A command running in the background. It keeps running after the request
 * that started it ends; `processes.attach(processId)` picks it up again.
 * Boat has no stdin for background commands.
 */
export interface Process {
  /** Boat's process id, as a string. */
  readonly id: string;
  readonly processId: number;
  /** stdout and stderr from where it was started or attached, until it exits. */
  readonly output: Stream.Stream<ProcessOutput, BoatError, RuntimeContext>;
  /** Stops the process. */
  kill(): Effect.Effect<void, BoatError, RuntimeContext>;
  /** Waits for it to exit, with the tail of what it printed. */
  readonly wait: Effect.Effect<ExecResult, BoatError, RuntimeContext>;
}

/** Background commands in the sandbox. */
export interface Processes {
  /** Picks up a background command by its process id. */
  attach(processId: number): Effect.Effect<Process, BoatError, RuntimeContext>;
}

/** A file or directory in the sandbox. */
export interface EntryInfo extends Sandbox.FileEntry {
  /** Octal permission bits, e.g. `0644`. */
  readonly mode: string;
  readonly modifiedAt: string;
}

/**
 * The sandbox's filesystem. Relative paths resolve in the home directory
 * (`/home/user`); Boat reaches only paths under `/home/user` and `/tmp`.
 * A missing path fails with `FileNotFound`.
 */
export interface Files extends Sandbox.Files<BoatError, EntryInfo> {
  read(path: string): Effect.Effect<Uint8Array, BoatError, RuntimeContext>;
  readText(path: string): Effect.Effect<string, BoatError, RuntimeContext>;
  /** Writes a file, creating parent directories. Files up to 5 MiB. */
  write(path: string, data: string | Uint8Array): Effect.Effect<void, BoatError, RuntimeContext>;
  list(path: string): Effect.Effect<ReadonlyArray<EntryInfo>, BoatError, RuntimeContext>;
  stat(path: string): Effect.Effect<EntryInfo, BoatError, RuntimeContext>;
  /** Removes a file, or a directory and everything in it. */
  remove(path: string): Effect.Effect<void, BoatError, RuntimeContext>;
  /** Creates the directory and its parents. */
  makeDir(path: string): Effect.Effect<void, BoatError, RuntimeContext>;
  exists(path: string): Effect.Effect<boolean, BoatError, RuntimeContext>;
  /** Moves a file or directory, creating the destination's parents. */
  move(
    source: string,
    destination: string,
    options?: { readonly overwrite?: boolean },
  ): Effect.Effect<void, BoatError, RuntimeContext>;
}

/**
 * A port inside a Boat sandbox, served at
 * `https://<subdomain>-<port>.on.boat.dev`. A protected port needs its
 * `token`, which `fetch` sends for you as Boat's `_port_auth` cookie.
 */
export interface Port extends Sandbox.SandboxPort<BoatError> {
  /** The port's URL, without its token. */
  readonly url: string;
  /** The port's access token, or `undefined` for a public port. */
  readonly token: Redacted.Redacted<string> | undefined;
}

export interface PortOptions {
  /** Serve the port without a token, to anyone. @default false */
  readonly public?: boolean;
  /** Set when the program listens on `127.0.0.1` only; Boat relays to it. @default false */
  readonly localhost?: boolean;
}

/**
 * What you can do with a sandbox, however you got it. Calls into a stopped
 * sandbox (`exec`, `start`, `files`, `getTcpPort`) fail with
 * `SandboxNotRunning`: `resume()` it first.
 */
export interface SandboxOperations
  extends
    Sandbox.SandboxExec<BoatError, ExecResult, ExecOptions>,
    Sandbox.SandboxFiles<BoatError, EntryInfo>,
    Sandbox.SandboxPorts<BoatError, Port> {
  /** Runs a command to completion. */
  exec(
    command: Command,
    options?: ExecOptions,
  ): Effect.Effect<ExecResult, BoatError, RuntimeContext>;
  /** Starts a command in the background. */
  start(
    command: Command,
    options?: StartOptions,
  ): Effect.Effect<Process, BoatError, RuntimeContext>;
  readonly processes: Processes;
  readonly files: Files;
  /** A port inside the sandbox. Boat hosts it on first use. */
  getTcpPort(port: number, options?: PortOptions): Effect.Effect<Port, BoatError, RuntimeContext>;
  /** Live details: state, size, environment, labels. */
  describe(): Effect.Effect<boat.Sandbox, BoatError, RuntimeContext>;
  /**
   * Stops the sandbox, saving its disk. Stopping a stopped sandbox
   * succeeds.
   */
  stop(): Effect.Effect<void, BoatError, RuntimeContext>;
  /**
   * Resumes a stopped sandbox (a no-op on a running one). `autoStop` sets
   * how long it runs before stopping again; `false` never stops it.
   */
  resume(options?: {
    readonly autoStop?: Duration.Input | false;
  }): Effect.Effect<void, BoatError, RuntimeContext>;
  /** Sets how long the sandbox runs from now before it stops; `false` never stops it. */
  setAutoStop(autoStop: Duration.Input | false): Effect.Effect<void, BoatError, RuntimeContext>;
  /** Saves the sandbox's disk as a named snapshot, and waits until it is ready. */
  snapshot(name: string): Effect.Effect<boat.SavedSnapshot, BoatError, RuntimeContext>;
}

/**
 * A sandbox created or connected at runtime (`CreateSandbox`). Holds only
 * its id, so it can be rebuilt with `connect(id)` in any request.
 */
export interface BoatSandbox extends SandboxOperations {
  readonly sandboxId: string;
  /** What Boat returned for the sandbox when it was created or connected. */
  readonly info: boat.Sandbox;
  /**
   * A copy of the sandbox from its last completed snapshot. Fails with
   * `ForkNeedsSnapshot` until it has one; stopping a sandbox snapshots it.
   */
  fork(
    options?: Omit<boat.ForkSandboxRequest, "sandboxId" | "ttlSeconds"> & {
      /** How long the fork runs before Boat stops it; `false` never stops it. */
      readonly autoStop?: Duration.Input | false;
    },
  ): Effect.Effect<BoatSandbox, BoatError, RuntimeContext>;
  /** Deletes the sandbox with its disk. Deleting one that is gone succeeds. */
  delete(): Effect.Effect<void, BoatError, RuntimeContext>;
}

/**
 * A sandbox declared in the stack (`ConnectSandbox`). The same operations
 * as {@link BoatSandbox} except `fork` and `delete`, which its key can't
 * do; its id is read at runtime.
 */
export interface ConnectedSandbox extends SandboxOperations {
  readonly sandboxId: Effect.Effect<string, never, RuntimeContext>;
}
