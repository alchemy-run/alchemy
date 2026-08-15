import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  WorkerExecutionContext,
  type AccessIdentityError,
} from "../Workers/Worker.ts";

/**
 * The Access identity Cloudflare attached to this request, or
 * `undefined` when Access did not authenticate it.
 *
 * Thin delegate over {@link WorkerExecutionContext.access.identity}.
 *
 * @see https://developers.cloudflare.com/workers/configuration/cloudflare-access/#read-authenticated-user-identity-with-ctxaccess
 * @see https://blog.cloudflare.com/workers-protected-by-access/
 */
export const getIdentity: Effect.Effect<
  cf.CloudflareAccessIdentity | undefined,
  AccessIdentityError,
  RuntimeContext | WorkerExecutionContext
> = Effect.gen(function* () {
  const ctx = yield* WorkerExecutionContext;
  return yield* ctx.access.identity;
});
