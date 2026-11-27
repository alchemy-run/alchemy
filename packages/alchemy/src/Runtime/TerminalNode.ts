import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SandboxPtyUnavailable } from "../SandboxAgentClient.ts";
import { Terminals } from "../Terminal.ts";

/**
 * The package `TerminalsNode` opens terminals with: `node-pty` with prebuilt
 * Linux binaries (glibc, x64 and arm64), so images need no compiler. Node.js
 * has no pseudo-terminals of its own, so an image whose program opens them
 * installs it beside the bundle, which leaves it external.
 */
export const NODE_PTY_PACKAGE = "@lydell/node-pty";
/** The version images install. */
export const NODE_PTY_VERSION = "1.2.0-beta.18";

interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string;
      env: Record<string, string | undefined>;
      encoding: null;
    },
  ): {
    write(data: string | Buffer): void;
    resize(cols: number, rows: number): void;
    onData(listener: (data: string | Buffer) => void): void;
    onExit(listener: (event: { exitCode: number }) => void): void;
  };
}

const loadNodePty = Effect.tryPromise({
  try: () => import(NODE_PTY_PACKAGE) as Promise<NodePty & { default?: NodePty }>,
  catch: (cause) =>
    new SandboxPtyUnavailable({
      message: `Terminals on Node.js need the ${NODE_PTY_PACKAGE} package installed next to the program: ${String(cause)}`,
    }),
}).pipe(Effect.map((module) => module.default ?? module));

/** Pseudo-terminals on Node.js, from {@link NODE_PTY_PACKAGE}. */
export const TerminalsNode = Layer.effect(
  Terminals,
  Effect.gen(function* () {
    // Loaded on the first terminal, so a program that never opens one needs
    // no package.
    const nodePty = yield* Effect.cached(loadNodePty);
    return {
      spawn: (options) =>
        Effect.flatMap(nodePty, (pty) =>
          Effect.try({
            try: () => {
              const [file, ...args] = options.argv;
              const terminal = pty.spawn(file, args, {
                name: options.env.TERM ?? "xterm-256color",
                cols: options.cols,
                rows: options.rows,
                cwd: options.cwd,
                env: options.env,
                // Raw bytes, so a multi-byte character split across reads
                // reaches the client intact.
                encoding: null,
              });
              const exited = new Promise<number>((resolve) =>
                terminal.onExit(({ exitCode }) => resolve(exitCode)),
              );
              terminal.onData((data) =>
                options.onData(
                  typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
                ),
              );
              return {
                write: (data: Uint8Array) => terminal.write(Buffer.from(data)),
                resize: (cols: number, rows: number) => terminal.resize(cols, rows),
                exited: Effect.promise(() => exited),
              };
            },
            catch: (cause) =>
              new SandboxPtyUnavailable({
                message: `The terminal could not be opened: ${String(cause)}`,
              }),
          }),
        ),
    };
  }),
);
