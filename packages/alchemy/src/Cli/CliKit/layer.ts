import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { detectCapabilities } from "@alchemy.run/sigil/capabilities";
import { isNonInteractive } from "../../Util/interactive.ts";
import { CliKit } from "./CliKit.ts";
import type { CliKitCapabilities, CliKitOptions } from "../components/types.ts";

const resolveCapabilities = (options: CliKitOptions): CliKitCapabilities => {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const detected = detectCapabilities({ stdout });
  const input =
    options.input ??
    (stdin.isTTY === true && stdout.isTTY === true && !isNonInteractive());
  return {
    input,
    columns: detected.size.columns,
    rows: detected.size.rows,
    colors: options.colors ?? detected.supports.color,
    unicode: options.unicode ?? detected.supports.unicode,
    alternateScreen: detected.supports.alternateScreen,
  };
};

type RuntimeModule = {
  readonly makeRuntime: (
    options: CliKitOptions,
    capabilities: CliKitCapabilities,
  ) => {
    readonly service: CliKit["Service"];
    readonly dispose: () => Promise<void>;
  };
};

// Node's type-stripper (`--experimental-transform-types`) loads `.ts` but
// rejects `.tsx` — JSX is a transform, not an erasure. The Vite child is
// spawned under Node even when the engine is bun (WebSocket upgrades on
// bun's `node:http` shim are broken), so a source checkout that dynamic-
// imported `Runtime.tsx` died with `Unknown file extension ".tsx"` before
// Vite became ready. Bun can load TSX; compiled `layer.js` rewrites the
// import to `Runtime.js`. Only the Node-from-source path needs the
// TypeScript-only fallback.
const canLoadJsx =
  typeof globalThis.Bun !== "undefined" || !import.meta.url.endsWith(".ts");

// One shared import promise per process. Concurrent dynamic imports of the
// same module (e.g. two test files building this layer at once) can race in
// bun and hand one caller a partially-evaluated namespace, which throws a
// TDZ ReferenceError on `makeRuntime`; funneling every build through a
// single import() sidesteps the race.
let sigilRuntime: Promise<RuntimeModule> | undefined;
const loadSigilRuntime = (): Promise<RuntimeModule> =>
  (sigilRuntime ??= canLoadJsx
    ? import("../components/view/Runtime.tsx")
    : import("./headless.ts"));

/** Provides one terminal runtime for the enclosing scope. */
export const layer = (options: CliKitOptions = {}) =>
  Layer.effect(
    CliKit,
    Effect.acquireRelease(
      Effect.promise(async () => {
        const capabilities = resolveCapabilities(options);
        const { makeRuntime } = await loadSigilRuntime();
        return makeRuntime(options, capabilities);
      }),
      ({ dispose }) => Effect.promise(dispose),
    ).pipe(Effect.map(({ service }) => service)),
  );
