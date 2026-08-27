import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/**
 * Options for {@link Sandbox}'s `exec`. The shape follows the
 * consensus across sandbox SDKs (Cloudflare Sandbox, Mastra, flue,
 * pi): working directory, environment overlay, a millisecond
 * timeout, and a byte retention cap per stream.
 */
export interface SandboxExecOptions {
  /** Working directory, sandbox-relative (default: the sandbox root). */
  readonly cwd?: string;
  /** Environment variables overlaid on the sandbox's own environment. */
  readonly env?: Record<string, string>;
  /**
   * Kill the process after this many milliseconds.
   * @default 60_000
   */
  readonly timeout?: number;
  /**
   * Maximum UTF-8 bytes retained per stream. When exceeded, the
   * OLDEST output is dropped and the newest kept (the end of a build
   * or test log is where the verdict is); the result's truncation
   * flags report the drop.
   * @default 1_048_576
   */
  readonly maxRetainedBytes?: number;
}

export interface SandboxExecResult {
  /** `exitCode === 0`. */
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Whether stdout dropped older output due to the retention cap. */
  readonly stdoutTruncated: boolean;
  /** Whether stderr dropped older output due to the retention cap. */
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
}

export interface SandboxEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "other";
}

/**
 * An interactive PTY on the sandbox machine — the seam an operator
 * terminal (ghostty in the org UI) attaches through. OPTIONAL on the
 * contract: only machines that can hold a real PTY expose it (the
 * MicroVM guest via `Bun.Terminal`); implementations without one
 * simply omit it and terminal attach reports unavailability.
 *
 * The PTY belongs to the MACHINE, not the connection: `open` is
 * idempotent (an existing `id` just adopts the caller's dimensions),
 * and `stream` replays the retained tail of output before going live —
 * so a dropped viewer reattaches and repaints instead of respawning
 * the shell.
 */
export interface SandboxPty {
  /** Ensure PTY `id` exists (spawn a login shell on first open). */
  readonly open: (
    id: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, string>;
  /** Retained tail (repaint), then live output until the shell exits. */
  readonly stream: (id: string) => Stream.Stream<Uint8Array, string>;
  /** Keystrokes — UTF-8 text, escape sequences included. */
  readonly input: (id: string, data: string) => Effect.Effect<void, string>;
  readonly resize: (
    id: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, string>;
  /** Kill the shell and drop the PTY. */
  readonly close: (id: string) => Effect.Effect<void, string>;
}

/**
 * The MACHINE lifecycle — only on sandboxes backed by a real, ownable
 * machine (a MicroVM, a container). OPTIONAL on the contract: an
 * implementation whose "machine" is the trusted host omits it, and
 * drivers treat a missing lifecycle as a no-op.
 *
 * Both verbs resolve the machine from the calling session's identity
 * (`Thread.key`, through the implementation's machine keying), exactly
 * like every other sandbox method — and both are best-effort session
 * hygiene, never correctness: an unsuspended machine still reaps
 * itself through its own idle policy.
 */
export interface SandboxLifecycle {
  /**
   * Suspend the session's machine (snapshot memory + disk, stop
   * compute); the next sandbox call or terminal keystroke resumes it.
   * Drivers call this when the session SETTLES — a settled session's
   * machine should not keep burning.
   */
  readonly suspend: Effect.Effect<void, string>;
  /**
   * Eagerly WAKE the session's suspended machine. OPTIONAL — absent,
   * the machine still wakes lazily on the next sandbox call; present,
   * drivers call it when a stopped session is RESUMED so the machine
   * is warm before the operator's next message.
   */
  readonly resume?: Effect.Effect<void, string>;
  /**
   * Terminate the session's machine and discard its disk. Idempotent.
   * Drivers call this when the session is REMOVED — an erased
   * session's machine has nothing left to hold.
   */
  readonly destroy: Effect.Effect<void, string>;
}

/**
 * THE SANDBOX COMPUTER — the pluggable machine an agent's tools work
 * on: run commands and read/write files. Tool implementations only
 * ever `yield* Sandbox`; WHERE the machine lives is a Layer decision:
 *
 * - `SandboxLocal` — the trusted host, physics over a {@link Workspace}
 *   containment root (fixed dir, or per-session git worktrees).
 * - `Cloudflare.SandboxContainer` — a per-session Cloudflare Container
 *   attached to the session's Durable Object.
 * - an AWS Lambda MicroVM behind the same contract (suspend/resume
 *   preserves the whole machine across idle).
 *
 * The surface deliberately matches what sandbox SDKs have converged
 * on (Cloudflare Sandbox, Mastra, flue, eve/AI SDK): shell-string
 * `exec` with collected output and plain file operations. Policies
 * that frameworks keep ABOVE this seam stay above it here too —
 * line-level output truncation, artifact retention, and
 * digest-guarded writes are tool-layer concerns. Git is a SEPARATE
 * seam: repositories materialize through `Git.Checkouts` (worktrees
 * on the host, artifact-fs mounts in containers), whose
 * implementations may run over this machine but are not part of it.
 *
 * Everything on the interface is JSON-serializable by contract — an
 * implementation that runs the machine across an isolate or network
 * boundary marshals requests and results as-is. Failures are
 * model-visible strings (the agent reads them and reacts), never
 * defects.
 */
export class Sandbox extends Context.Service<
  Sandbox,
  {
    /**
     * Run a shell command to completion and return its collected
     * output. When `args` is provided, each argument is shell-quoted
     * and appended to `command` (the Mastra convention) — so callers
     * composing commands programmatically never hand-roll quoting.
     */
    readonly exec: (
      command: string,
      args?: ReadonlyArray<string>,
      options?: SandboxExecOptions,
    ) => Effect.Effect<SandboxExecResult, string>;
    /** Read a UTF-8 text file (fails on binaries). */
    readonly readFile: (path: string) => Effect.Effect<string, string>;
    /** Write a text file atomically, creating parent directories. */
    readonly writeFile: (
      path: string,
      content: string,
    ) => Effect.Effect<void, string>;
    /** Delete a file. */
    readonly deleteFile: (path: string) => Effect.Effect<void, string>;
    /** Create a directory (recursive). */
    readonly mkdir: (path: string) => Effect.Effect<void, string>;
    /** List a directory's immediate entries. */
    readonly listFiles: (
      path?: string,
    ) => Effect.Effect<ReadonlyArray<SandboxEntry>, string>;
    /** Whether a file or directory exists. */
    readonly exists: (path: string) => Effect.Effect<boolean, string>;
    /** Interactive PTY surface — only on machines that can hold one. */
    readonly pty?: SandboxPty;
    /** Machine lifecycle — only on sandboxes backed by a real machine. */
    readonly lifecycle?: SandboxLifecycle;
  }
>()("alchemy/AI/Sandbox") {}
