import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SandboxPtyUnavailable } from "../SandboxAgentClient.ts";
import { Terminals } from "../Terminal.ts";

/** Pseudo-terminals from Bun's built-in `Bun.spawn({ terminal })`. */
export const TerminalsBun = Layer.succeed(Terminals, {
  spawn: (options) =>
    Effect.try({
      try: () => {
        const subprocess = Bun.spawn([...options.argv], {
          cwd: options.cwd,
          env: options.env,
          terminal: {
            cols: options.cols,
            rows: options.rows,
            // Bun reuses the buffer it hands over, so keep a copy.
            data: (_terminal, data) => options.onData(data.slice()),
          },
        });
        return {
          write: (data: Uint8Array) => {
            subprocess.terminal?.write(data);
          },
          resize: (cols: number, rows: number) => {
            subprocess.terminal?.resize(cols, rows);
          },
          exited: Effect.promise(() => subprocess.exited),
        };
      },
      catch: (cause) =>
        new SandboxPtyUnavailable({
          message: `The terminal could not be opened: ${String(cause)}`,
        }),
    }),
});
