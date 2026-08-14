/**
 * The `CloudflareEnvironment` service class as an import-graph LEAF.
 *
 * `CloudflareEnvironment.ts` wires the engine's auth machinery
 * (`Auth/AuthProvider.ts` → OAuth client → `node:http`; `Auth/Profile.ts`
 * → `node:os`) into its static closure. Runtime bridges compiled by
 * foreign bundlers (Next/turbopack, nitro rollup) into server bundles
 * that run on workerd must import THIS module for the tag — a `node:*`
 * external at module scope is a hard 500 on every request there.
 * `CloudflareEnvironment.ts` re-exports the class, so service identity is
 * shared.
 */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { CloudflareResolvedCredentials } from "./Auth/AuthProvider.ts";

export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  Effect.Effect<CloudflareResolvedCredentials>
>()("Cloudflare::CloudflareEnvironment") {
  readonly kind = "Environment" as const;
}
