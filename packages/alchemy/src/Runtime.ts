/**
 * Runtime helpers consumed by generated bundle entrypoints (Cloudflare
 * Workers, Cloudflare Containers, AWS Lambda, …).
 *
 * Anything exported here runs *inside* the deployed function — keep the
 * surface tiny and dependency-light.
 */

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sanitizeKey, unwrapRedactedMarker } from "./RuntimeContext.ts";
import { asEffect } from "./Util/types.ts";

/**
 * Resolve the user's default-export entrypoint into a `Layer` for the
 * bundled runtime.
 *
 * `entrypoint` may be any of:
 *   - a `Layer` factory (`{ build: (...) => ... }`) — used as-is
 *   - an Alchemy `Platform`/`Worker` construct (now a real `Effect`)
 *   - a plain `Effect`
 *
 * Centralized so the inline ternary doesn't have to be re-emitted into
 * every bundle template (and accidentally rewritten to `x : x` by a bulk
 * replace, which silently swaps the class in for the Effect and bricks
 * every deployed worker/lambda).
 */
export const makeEntrypointLayer = (tag: any, entrypoint: any): Layer.Layer<any> => {
  if (typeof entrypoint?.build === "function") {
    return entrypoint;
  }
  return Layer.effect(tag, asEffect(entrypoint));
};

/**
 * The `ConfigProvider` every deployed runtime uses for `Config` reads.
 *
 * It reads `source` (the host's environment) and returns each string exactly
 * as set, even one that parses as JSON (`"false"`, `"1.0"`, a long number),
 * with two exceptions:
 *
 * - **Values Alchemy bound.** During Init, every `Config` read is bound onto
 *   the deploy target as a secret, so it arrives as a
 *   `{"_tag":"Redacted","value":...}` marker. It is unwrapped back to the
 *   original string ({@link unwrapRedactedMarker}).
 * - **Renamed keys.** A name like `my.key` is bound as `my_key`
 *   ({@link sanitizeKey}), so a miss retries under that name.
 *
 * `ALCHEMY_PHASE` always reads `"runtime"`.
 *
 * Process hosts provide {@link RuntimeConfigProviderLive}. A host whose env is
 * an object of bindings (a Worker) passes `ConfigProvider.fromUnknown(env)`.
 */
export const runtimeConfigProvider = (
  source: ConfigProvider.ConfigProvider = ConfigProvider.fromEnv(),
): ConfigProvider.ConfigProvider =>
  ConfigProvider.orElse(
    ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
    ConfigProvider.make((path) =>
      source.load(path).pipe(
        Effect.flatMap((node) => {
          const key = sanitizeKey(path.join("_"));
          return node === undefined && !(path.length === 1 && path[0] === key)
            ? source.load([key])
            : Effect.succeed(node);
        }),
        Effect.map((node) =>
          // Record and Array nodes carry a value too (`PORT` beside `PORT_X`).
          node?.value === undefined ? node : { ...node, value: unwrapRedactedMarker(node.value) },
        ),
      ),
    ),
  );

/**
 * {@link runtimeConfigProvider} over `process.env`. Every process-based
 * runtime host (Lambda, containers, VMs, sandboxes) provides this Layer.
 */
export const RuntimeConfigProviderLive: Layer.Layer<never> = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.sync(() => runtimeConfigProvider()),
);
