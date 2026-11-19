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
import { decodeConfigString, sanitizeKey } from "./RuntimeContext.ts";
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
 * Wrap a runtime's env-backed `ConfigProvider` so values that were
 * auto-bound by the deploy-time `Config` interceptor decode transparently.
 *
 * The engine can't know which config values are sensitive, so the
 * interceptor binds every `Config` read during Init onto the deploy target
 * as a secret, serialized as a `{"_tag":"Redacted","value":<source>}`
 * marker. Every runtime host MUST install this wrapper as its ambient
 * `ConfigProvider`: it is the one place a runtime `Config` read is decoded,
 * during Init (the interceptor in `Platform.ts` passes its nodes through) and
 * in handlers alike. Without it, `Config.Number("PORT")` sees the marker JSON
 * instead of the source value and fails with a schema error.
 *
 * Two behaviors:
 * - Leaf values that carry the marker are unwrapped to the raw source
 *   string before `Config` schemas decode them; everything else passes
 *   through verbatim, even when it parses as JSON (see
 *   `decodeConfigString`).
 * - On a miss, falls back to the flat `sanitizeKey`-canonicalized key
 *   (`my.key` → `my_key`) that the interceptor bound the value under, so
 *   config names with non-alphanumeric characters resolve at runtime too.
 */
export const reifyBoundConfigProvider = (
  base: ConfigProvider.ConfigProvider,
  env: Record<string, unknown>,
): ConfigProvider.ConfigProvider =>
  ConfigProvider.make((path) =>
    base.load(path).pipe(
      Effect.map((node) => {
        // Record and Array nodes carry a scalar too (`PORT` beside `PORT_X`).
        if (node?.value !== undefined) {
          const value = decodeConfigString(node.value);
          return value === node.value
            ? node
            : node._tag === "Value"
              ? ConfigProvider.makeValue(value)
              : node._tag === "Record"
                ? ConfigProvider.makeRecord(node.keys, value)
                : ConfigProvider.makeArray(node.length, value);
        }
        if (node === undefined) {
          const raw = env[sanitizeKey(path.map((p) => p.toString()).join("_"))];
          if (typeof raw === "string") {
            return ConfigProvider.makeValue(decodeConfigString(raw));
          }
        }
        return node;
      }),
    ),
  );
