import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SandboxPtyUnavailable } from "./SandboxAgentClient.ts";

/**
 * Opens pseudo-terminals on the machine a program runs on. The sandbox agent
 * uses it for `pty`. Each runtime ships its own Layer: `TerminalsBun` in
 * `alchemy/Runtime/TerminalBun`, `TerminalsNode` in
 * `alchemy/Runtime/TerminalNode`. A program without one answers `pty` with
 * `SandboxPtyUnavailable`.
 */
export class Terminals extends Context.Service<
  Terminals,
  {
    readonly spawn: (
      options: TerminalSpawnOptions,
    ) => Effect.Effect<TerminalProcess, SandboxPtyUnavailable>;
  }
>()("alchemy/Terminals") {}

export interface TerminalSpawnOptions {
  /** The program and its arguments. */
  readonly argv: readonly [string, ...string[]];
  readonly cwd?: string;
  /** The terminal's whole environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cols: number;
  readonly rows: number;
  /** Receives everything the terminal prints. The buffer is the caller's to keep. */
  readonly onData: (data: Uint8Array) => void;
}

/** A program running in a pseudo-terminal. */
export interface TerminalProcess {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Completes with the exit code when the program ends. */
  readonly exited: Effect.Effect<number>;
}
