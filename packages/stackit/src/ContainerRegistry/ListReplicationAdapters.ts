import type * as registry from "@distilled.cloud/stackit/registry";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListReplicationAdaptersRequest extends Omit<
  registry.ListReplicationAdaptersRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Container Registry's `listReplicationAdapters`: list the upstream registry types a pull-through cache project can mirror, the values of `proxy.registryType`.
 *
 * Bind this operation to a {@link Project} in a Function/Worker init phase and
 * provide {@link ListReplicationAdaptersHttp}. The project's STACKIT project and region are injected into each request. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding `container-registry.project.create`, the permission the
 * API's spec names. The API requires this permission, as the spec declares, though the operation only reads. STACKIT binds roles on projects at the narrowest, so the
 * role reaches every registry project in the STACKIT project.
 *
 * ### Listing Replication Adapters
 * **Example:** List the upstream types from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Images = Stackit.ContainerRegistry.Project("Images", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const images = yield* Images;
 *     const listReplicationAdapters = yield* Stackit.ContainerRegistry.ListReplicationAdapters(images);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { replication_adapters } = yield* listReplicationAdapters({});
 *         return yield* HttpServerResponse.json({
 *           types: replication_adapters.map((adapter) => adapter.registry_type),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerRegistry.ListReplicationAdaptersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Containers
 */
export interface ListReplicationAdapters extends Binding.Service<
  ListReplicationAdapters,
  "Stackit.ContainerRegistry.ListReplicationAdapters",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListReplicationAdaptersRequest,
    ) => Effect.Effect<
      registry.ReplicationAdapterList,
      registry.ListReplicationAdaptersError,
      RuntimeContext
    >
  >
> {}

export const ListReplicationAdapters = Binding.Service<ListReplicationAdapters>(
  "Stackit.ContainerRegistry.ListReplicationAdapters",
);
