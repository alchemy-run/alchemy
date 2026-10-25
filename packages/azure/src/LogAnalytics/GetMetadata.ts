import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

export interface GetMetadataRequest extends Omit<query.GetMetadataRequest, "workspaceId"> {}

/**
 * Read a Log Analytics workspace's schema (`GET /metadata`): its tables and
 * columns, functions, solutions, and saved queries, from any host.
 *
 * Binding assigns the built-in **Log Analytics Data Reader** (actions
 * `workspaces/read` and `workspaces/query/read`, data action
 * `workspaces/tables/data/read`: the smallest built-in role that runs
 * queries) on the workspace only. On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group, VM,
 * or AKS workload identity) the role goes to that identity; any other host
 * (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetMetadataHttp}.
 *
 * ### Calling GetMetadata
 * **Example:** GetMetadata from a Function
 * ```typescript
 * // init
 * const getMetadata = yield* Azure.LogAnalytics.GetMetadata(workspace);
 *
 * // runtime
 * const metadata = yield* getMetadata();
 * const tables = (metadata.tables ?? []).map((table) => table.name);
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getMetadata = yield* Azure.LogAnalytics.GetMetadata(workspace);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.GetMetadataHttp));
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface GetMetadata extends Binding.Service<
  GetMetadata,
  "Azure.LogAnalytics.GetMetadata",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request?: GetMetadataRequest,
    ) => Effect.Effect<query.MetadataResults, query.GetMetadataError, RuntimeContext>
  >
> {}

export const GetMetadata = Binding.Service<GetMetadata>("Azure.LogAnalytics.GetMetadata");
