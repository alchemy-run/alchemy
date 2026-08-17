/**
 * The `CloudflareEnvironment` SERVICE — an import-graph LEAF, safe for
 * foreign-bundled server code (workerd rejects `node:*` externals at
 * module scope) and engine modules alike. The Layer factories whose
 * profile/OAuth resolution reaches `node:http`/`node:os` live in
 * `CloudflareEnvironmentLayers.ts`, built over this same tag.
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
