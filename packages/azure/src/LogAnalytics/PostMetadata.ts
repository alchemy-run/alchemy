import type * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

export interface PostMetadataRequest extends Omit<query.PostMetadataRequest, "workspaceId"> {}

/**
 * Read a Log Analytics workspace's schema with a `POST /metadata` (same
 * result as {@link GetMetadata}) from any host.
 *
 * Binding assigns the built-in **Log Analytics Data Reader** (actions
 * `workspaces/read` and `workspaces/query/read`, data action
 * `workspaces/tables/data/read`: the smallest built-in role that runs
 * queries) on the workspace only. On a host with a managed identity (an
 * Azure Function, Function App, Web App, Container App, container group, VM,
 * or AKS workload identity) the role goes to that identity; any other host
 * (a Cloudflare Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link PostMetadataHttp}.
 *
 * ### Calling PostMetadata
 * **Example:** PostMetadata from a Function
 * ```typescript
 * // init
 * const postMetadata = yield* Azure.LogAnalytics.PostMetadata(workspace);
 *
 * // runtime
 * const metadata = yield* postMetadata();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const postMetadata = yield* Azure.LogAnalytics.PostMetadata(workspace);
 *   // ...
 * }).pipe(Effect.provide(Azure.LogAnalytics.PostMetadataHttp));
 * ```
 *
 * @binding
 * @category LogAnalytics
 */
export interface PostMetadata extends Binding.Service<
  PostMetadata,
  "Azure.LogAnalytics.PostMetadata",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request?: PostMetadataRequest,
    ) => Effect.Effect<query.MetadataResults, query.PostMetadataError, RuntimeContext>
  >
> {}

export const PostMetadata = Binding.Service<PostMetadata>("Azure.LogAnalytics.PostMetadata");
