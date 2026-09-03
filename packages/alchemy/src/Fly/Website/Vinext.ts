import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import type { Redis } from "../Redis.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The vinext-on-Node framework module (`vinext build` +
 * `startProdServer`). Not the Cloudflare Worker source.
 */
export const VINEXT_NODE_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/node";

export interface VinextProps extends FrameworkSiteProps {
  /**
   * Optional Upstash Redis for ISR / `"use cache"`. Bound onto the
   * hosted Service so Alchemy writes `REDIS_URL` as an App secret.
   * Spread `alchemy()` into `vinext({ ...alchemy() })` so the Node
   * build bakes the Redis adapter.
   */
  redis?: Redis;
}

/**
 * Deploy a [vinext](https://vinext.dev) application to Fly as a
 * long-running Node process: `vinext build`, then vinext's production
 * server (`startProdServer`). The `dist/` output is baked into the
 * image; `vinext` is installed unbundled.
 *
 * Do not use the Cloudflare Worker entry (`vinext/server/fetch-handler`)
 * — that is workerd.
 *
 * ISR / `"use cache"` persist in Redis when you pass {@link VinextProps.redis}
 * and `vinext({ ...alchemy() })` — not Cloudflare KV. Missing `REDIS_URL`
 * (local `vinext start` / `alchemy dev`) falls back to memory.
 *
 * During `alchemy dev` the site is `vinext dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live Service path.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* Fly.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Redis data cache
 * ```typescript
 * const redis = yield* Fly.Redis("Cache", { eviction: true });
 * const site = yield* Fly.Website.Vinext("Web", {
 *   redis,
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Fly.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vinext = (id: string, propsIn: VinextProps = {}) =>
  Effect.gen(function* () {
    const { redis, ...props } = propsIn;
    const site = yield* makeFrameworkSite(id, props, {
      name: "Vinext",
      framework: VINEXT_NODE_FRAMEWORK_SPECIFIER,
      target: VINEXT_NODE_FRAMEWORK_SPECIFIER,
      install: ["vinext", "react", "react-dom", "react-server-dom-webpack"],
    });
    if (redis !== undefined && site.service !== undefined) {
      yield* site.service.bind`${redis}`({
        redis: { name: redis.name, id: redis.redisId },
      });
    }
    return site;
  }).pipe(Namespace.push(id));
