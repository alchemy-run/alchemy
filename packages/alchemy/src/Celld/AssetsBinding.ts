import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import {
  fromNativeFetcher,
  type Fetcher,
  type NativeFetcher,
} from "./Fetcher.ts";

export interface Assets extends Binding.Service<
  Assets,
  "Celld.Assets",
  (name?: string) => Effect.Effect<Fetcher>
> {}

/**
 * Access a Worker's native assets Fetcher. Configure the matching name in
 * `assets.binding` on the Worker; this accessor does not create an asset directory
 * or silently change asset routing. The default binding name is `ASSETS`.
 * Requests use Celld's native asset router, including `_headers` and `_redirects`.
 * Only fetch is supported; there is no RPC, TCP or workerd stub-transfer API.
 *
 * ### Serve an asset
 * **Example:** Forward from a Worker configured with an ASSETS binding
 * ```typescript
 * // Worker props: { assets: { directory: "public", binding: "ASSETS", runWorkerFirst: true } }
 * const assets = yield* Celld.Assets();
 * return { fetch: Effect.gen(function* () {
 *   const request = yield* HttpServerRequest;
 *   return yield* assets.fetch(request);
 * }) };
 * ```
 * Provide `Celld.AssetsBinding` on the Worker's initialization effect. Keep raw
 * native fetch calls within the current request; raw access bypasses Effect errors.
 *
 * @binding
 * @product Celld
 * @category Workers & Compute
 */
export const Assets = Binding.Service<Assets>("Celld.Assets");

/**
 * Read the configured native assets binding lazily from the captured environment.
 * No request I/O or native response is retained across events.
 *
 * @layer
 * @provides Celld.Assets
 * @product Celld
 */
export const AssetsBinding = Layer.effect(
  Assets,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    return (name = "ASSETS") =>
      Effect.succeed(
        fromNativeFetcher({
          fetch: (request, init) => {
            const native = env[name] as NativeFetcher | undefined;
            if (!native || typeof native.fetch !== "function")
              throw new Error(
                `Missing Celld assets binding '${name}'; configure Worker assets.binding`,
              );
            return native.fetch(request, init);
          },
        }),
      );
  }),
);
