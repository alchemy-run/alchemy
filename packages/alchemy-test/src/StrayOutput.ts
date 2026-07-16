/**
 * Stray-output capture: while a run is active, JS-level writes to
 * process.stdout/stderr that don't go through the reporter (third-party
 * bridges like miniflare forwarding workerd's console, e.g.
 * "[vite] program reload") are diverted into the run log instead of
 * interleaving with reporter output (plain mode) or corrupting the
 * alternate screen (TUI mode).
 *
 * The reporter itself writes through {@link writeDirect}, which always uses
 * the REAL stream. Note: `console.log` in bun does not go through
 * `process.stdout.write` (it's captured per-test via the Effect Console
 * instead), and child processes spawned with `stdio: "inherit"` write to the
 * fd directly — neither can be intercepted here; those are fixed at their
 * source.
 */
// The sink runs inside a synchronous stream-write patch — it cannot be
// effectful, so this module uses node:fs append directly (append mode is
// atomic enough for interleaving with the Effect-based FileLog appends).
import { appendFileSync } from "node:fs";

type StreamWrite = typeof process.stdout.write;

let realStdoutWrite: StreamWrite | undefined;
let realStderrWrite: StreamWrite | undefined;

/** Write to the real terminal, bypassing any active stray-output capture. */
export const writeDirect = (text: string): void => {
  const write = realStdoutWrite ?? process.stdout.write.bind(process.stdout);
  write(text);
};

const decoder = new TextDecoder();

/**
 * Divert stray stdout/stderr writes into `logFile` (prefixed per line).
 * Returns a restore function; safe to call multiple times.
 */
export const captureStrayOutput = (logFile: string): (() => void) => {
  if (realStdoutWrite !== undefined) return () => {};
  realStdoutWrite = process.stdout.write.bind(process.stdout);
  realStderrWrite = process.stderr.write.bind(process.stderr);

  const divert =
    (stream: "stdout" | "stderr"): StreamWrite =>
    (
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      try {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
        const prefixed = text
          .split("\n")
          .map((line) => (line === "" ? line : `[stray ${stream}] ${line}`))
          .join("\n");
        appendFileSync(
          logFile,
          prefixed.endsWith("\n") ? prefixed : `${prefixed}\n`,
        );
      } catch {
        // Never let log diversion break the writer.
      }
      callback?.(null);
      return true;
    };

  process.stdout.write = divert("stdout");
  process.stderr.write = divert("stderr");

  return () => {
    if (realStdoutWrite !== undefined) {
      process.stdout.write = realStdoutWrite;
      realStdoutWrite = undefined;
    }
    if (realStderrWrite !== undefined) {
      process.stderr.write = realStderrWrite;
      realStderrWrite = undefined;
    }
  };
};
