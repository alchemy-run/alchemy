import * as deploymentApi from "@distilled.cloud/convex/deployment";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hostKey, onHost } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";

export interface DataSyncClient {
  /** Read the next page of a data export. Omit `cursor` to start from scratch. */
  sync(
    request: deploymentApi.StartDataSyncRequest,
  ): Effect.Effect<
    deploymentApi.DataSyncResponse,
    deploymentApi.StartDataSyncError,
    RuntimeContext
  >;
  /** The progress of every active sync. */
  list(): Effect.Effect<
    deploymentApi.ListActiveSyncsResponse,
    deploymentApi.ListActiveSyncsError,
    RuntimeContext
  >;
  /** The progress of one sync. */
  get(
    syncId: string,
  ): Effect.Effect<deploymentApi.ActiveDataSync, deploymentApi.GetActiveSyncError, RuntimeContext>;
}

/**
 * Export a Convex deployment's data from a Worker, Lambda or other host, a
 * page at a time.
 *
 * The host gets a deploy key that can only do `deployment:data:view` on this
 * deployment, which reads every table.
 * The Deployment API accepts only Convex's own keys, so there is no host
 * identity to federate.
 *
 * :::caution
 * Data sync needs the Convex Professional plan. Below it, calls fail with
 * `StreamingExportNotEnabled`.
 * :::
 *
 * ### Exporting Data
 * **Example:** Read the first page
 * ```typescript
 * Effect.gen(function* () {
 *   const data = yield* Convex.DataSync(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const page = yield* data.sync({});
 *       return yield* HttpServerResponse.json(page);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.DataSyncHttp));
 * ```
 *
 * @binding
 * @product Deployment
 */
export interface DataSync extends Binding.Service<
  DataSync,
  "Convex.DataSync",
  (deployment: Deployment) => Effect.Effect<DataSyncClient>
> {}

export const DataSync = Binding.Service<DataSync>("Convex.DataSync");

/** Implementation over the Deployment API, usable from any host. */
export const DataSyncHttp = Layer.effect(
  DataSync,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const key = yield* hostKey(deployment, "Data", ["deployment:data:view"]);
      const on = onHost(yield* deployment.url, key);
      return {
        sync: (request) => deploymentApi.startDataSync(request).pipe(on),
        list: () => deploymentApi.listActiveSyncs({}).pipe(on),
        get: (syncId) => deploymentApi.getActiveSync({ syncId }).pipe(on),
      } satisfies DataSyncClient;
    }),
  ),
);
