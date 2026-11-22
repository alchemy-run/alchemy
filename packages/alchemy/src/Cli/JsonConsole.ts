import { Console } from "node:console";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLineBuffer } from "../Util/LineBuffer.ts";
import { logChildLine } from "../Util/LogRecord.ts";
import { jsonConsole, selectRenderer } from "./selectCli.ts";

/**
 * The JSON console (`--log-format json`): stdout carries log records only,
 * one JSON line each in the run log's envelope, so the output can be piped.
 * No TUI or prompts; errors print as text on stderr.
 */

/**
 * Stdout as log records for the scope: anything else written to it (the
 * stack's `console.log` or `Console.log`, a tool printing directly) becomes
 * an `output` record through the current loggers, so stdout stays JSON
 * lines only. The JSON console sink writes through the original `write`.
 * The global console is swapped too, since Bun's native console doesn't go
 * through `process.stdout.write`. The TUI captures console output the same
 * way when it mounts, but never under a JSON console: the CLI's renderer is
 * replaced inside the command (see {@link override}), so the TUI built
 * before parsing stays unmounted, and the exec child builds none.
 */
const captureStdout = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const lines = makeLineBuffer((line) =>
    Effect.runSyncWith(context)(logChildLine(line, { stream: "stdout" })),
  );
  const decoder = new StringDecoder("utf8");
  const capture = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      lines.push(decoder.write(chunk));
      callback();
    },
  });
  const write = process.stdout.write.bind(process.stdout);
  const console = globalThis.console;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.stdout.write = capture.write.bind(capture) as typeof process.stdout.write;
      globalThis.console = Object.assign(new Console({ stdout: capture, stderr: process.stderr }), {
        // Bun's raw `console.write`.
        write: (...data: Array<string | ArrayBufferView | ArrayBuffer>) => {
          const bytes = Buffer.concat(
            data.map((part) =>
              typeof part === "string"
                ? Buffer.from(part)
                : ArrayBuffer.isView(part)
                  ? Buffer.from(part.buffer, part.byteOffset, part.byteLength)
                  : Buffer.from(part),
            ),
          );
          capture.write(bytes);
          return bytes.byteLength;
        },
      });
    }),
    () =>
      Effect.sync(() => {
        process.stdout.write = write;
        globalThis.console = console;
        lines.push(decoder.end());
        lines.flush();
      }),
  );
});

/** `effect` with stdout captured as log records, when the console is JSON. */
export const captureStdoutAround = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(jsonConsole, (json) =>
    json ? Effect.scoped(Effect.andThen(captureStdout, effect)) : effect,
  );

/**
 * The JSON renderer ({@link selectRenderer}), with stdout captured, over
 * whatever renderer is already provided, when the console is JSON. Effect CLI provides parsed flags to
 * command handlers only, so the CLI provides this on its root command
 * (`Command.provide`), where `--log-format` and the CLI's loggers are known.
 */
export const override = Layer.unwrap(
  Effect.map(jsonConsole, (json) =>
    json ? Layer.merge(selectRenderer(), Layer.effectDiscard(captureStdout)) : Layer.empty,
  ),
);
