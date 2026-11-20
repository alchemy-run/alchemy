import * as appsync from "@distilled.cloud/aws/appsync";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppSyncApiHttpBinding } from "./BindingHttp.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * Runtime binding for `appsync:FlushApiCache` — flush a {@link GraphqlApi}'s
 * server-side cache from a Lambda (or other AWS runtime), e.g. after
 * writing to the underlying data store out of band.
 *
 * Fails with the typed `NotFoundException` when the API has no cache
 * provisioned. Provide `AppSync.FlushApiCacheHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * ### Flushing the API Cache
 * **Example:** Invalidate cached resolver results after an out-of-band write
 * ```typescript
 * const flushCache = yield* AppSync.FlushApiCache(api);
 *
 * yield* flushCache().pipe(
 *   // no cache provisioned — nothing to flush
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 *
 * @binding
 */
export interface FlushApiCache extends Binding.Service<
  FlushApiCache,
  "AWS.AppSync.FlushApiCache",
  (
    api: GraphqlApi,
  ) => Effect.Effect<() => Effect.Effect<appsync.FlushApiCacheResponse, appsync.FlushApiCacheError>>
> {}
export const FlushApiCache = Binding.Service<FlushApiCache>("AWS.AppSync.FlushApiCache");

/**
 * HTTP implementation of the {@link FlushApiCache} binding. Calls
 * `appsync:FlushApiCache` with the Lambda's IAM role. The action defines
 * no IAM resource types, so the grant is necessarily `Resource: "*"`; the
 * runtime callable itself is fixed to the bound API's `apiId`.
 */
export const FlushApiCacheHttp = Layer.effect(
  FlushApiCache,
  makeAppSyncApiHttpBinding({
    tag: "AWS.AppSync.FlushApiCache",
    actions: ["appsync:FlushApiCache"],
    operation: appsync.flushApiCache,
  }),
);
