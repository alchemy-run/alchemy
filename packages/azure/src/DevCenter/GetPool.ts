import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetPoolRequest extends Omit<
  devcenter.GetDevBoxPoolRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read a dev box pool (its SKU, image, and health) of the bound Dev Center
 * project from any host.
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
 * Provide {@link GetPoolHttp}.
 *
 * ### Calling GetPool
 * **Example:** GetPool from a Function
 * ```typescript
 * // init
 * const getPool = yield* Azure.DevCenter.GetPool(project);
 *
 * // runtime
 * const pool = yield* getPool({ poolName: "engineering" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetPool extends Binding.Service<
  GetPool,
  "Azure.DevCenter.GetPool",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetPoolRequest,
    ) => Effect.Effect<devcenter.Pool, devcenter.GetDevBoxPoolError, RuntimeContext>
  >
> {}

export const GetPool = Binding.Service<GetPool>("Azure.DevCenter.GetPool");
