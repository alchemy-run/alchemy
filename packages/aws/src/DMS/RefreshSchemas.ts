import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDmsConnectionScopedHttpBinding } from "./BindingHttp.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";

/**
 * Runtime binding for `dms:RefreshSchemas`.
 *
 * Bind this operation to a ({@link ReplicationInstance}, {@link Endpoint})
 * pair to (re)discover the schemas at the endpoint's database using the
 * instance's compute. The refresh runs asynchronously — poll it with
 * {@link DescribeRefreshSchemasStatus}, then list the result with
 * {@link DescribeSchemas}. Provide the implementation with
 * `Effect.provide(AWS.DMS.RefreshSchemasHttp)`.
 * ### Refreshing Schemas
 * **Example:** Kick Off a Schema Refresh
 * ```typescript
 * // init — bind the operation to the instance + endpoint
 * const refreshSchemas = yield* AWS.DMS.RefreshSchemas(instance, source);
 *
 * // runtime
 * const { RefreshSchemasStatus } = yield* refreshSchemas();
 * ```
 *
 * @binding
 */
export interface RefreshSchemas extends Binding.Service<
  RefreshSchemas,
  "AWS.DMS.RefreshSchemas",
  (
    instance: ReplicationInstance,
    endpoint: Endpoint,
  ) => Effect.Effect<() => Effect.Effect<dms.RefreshSchemasResponse, dms.RefreshSchemasError>>
> {}

export const RefreshSchemas = Binding.Service<RefreshSchemas>("AWS.DMS.RefreshSchemas");

export const RefreshSchemasHttp = Layer.effect(
  RefreshSchemas,
  makeDmsConnectionScopedHttpBinding({
    tag: "AWS.DMS.RefreshSchemas",
    actions: ["dms:RefreshSchemas"],
    operation: dms.refreshSchemas,
  }),
);
