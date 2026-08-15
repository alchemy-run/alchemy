import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isNonInteractive } from "../../Util/interactive.ts";
import { CliKit } from "./CliKit.ts";
import type { CliKitCapabilities, CliKitOptions } from "./types.ts";

const resolveCapabilities = (options: CliKitOptions): CliKitCapabilities => {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const input =
    options.input ??
    (stdin.isTTY === true && stdout.isTTY === true && !isNonInteractive());
  return {
    input,
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
    colors:
      options.colors ??
      (process.env.NO_COLOR === undefined &&
        ((process.env.FORCE_COLOR !== undefined &&
          process.env.FORCE_COLOR !== "0") ||
          (stdout.hasColors?.() ?? stdout.isTTY === true))),
    unicode: options.unicode ?? process.env.TERM !== "dumb",
  };
};

/** Provides one terminal runtime for the enclosing scope. */
export const layer = (options: CliKitOptions = {}) =>
  Layer.effect(
    CliKit,
    Effect.acquireRelease(
      Effect.promise(async () => {
        const capabilities = resolveCapabilities(options);
        if (!capabilities.input) {
          const { makeRuntime } = await import("./PlainRuntime.ts");
          return makeRuntime(options, capabilities);
        }
        const { makeRuntime } = await import("./InkRuntime.tsx");
        return makeRuntime(options, capabilities);
      }),
      ({ dispose }) => Effect.promise(dispose),
    ).pipe(Effect.map(({ service }) => service)),
  );
