import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListPoolsRequest extends Omit<
  devcenter.ListDevBoxPoolsRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the dev box pools of the bound Dev Center project (one page; pass
 * `nextLink` for the next) from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterPoolReadRole`, one per stack)
 * with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/pools/read`, on the project only. The
 * smallest built-in role, **DevCenter Dev Box User**, also grants
 * `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListPoolsHttp}.
 *
 * ### Calling ListPools
 * **Example:** ListPools from a Function
 * ```typescript
 * // init
 * const listPools = yield* Azure.DevCenter.ListPools(project);
 *
 * // runtime
 * const page = yield* listPools();
 * const names = page.value.map((pool) => pool.name);
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListPools extends Binding.Service<
  ListPools,
  "Azure.DevCenter.ListPools",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListPoolsRequest,
    ) => Effect.Effect<devcenter.PagedPool, devcenter.ListDevBoxPoolsError, RuntimeContext>
  >
> {}

export const ListPools = Binding.Service<ListPools>("Azure.DevCenter.ListPools");
