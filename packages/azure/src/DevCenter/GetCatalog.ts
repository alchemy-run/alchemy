import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetCatalogRequest extends Omit<
  devcenter.GetEnvironmentCatalogRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read a catalog of the bound Dev Center project from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterCatalogReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/read`, on the project only. The
 * smallest built-in role, **Deployment Environments User**, also grants
 * `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetCatalogHttp}.
 *
 * ### Calling GetCatalog
 * **Example:** GetCatalog from a Function
 * ```typescript
 * // init
 * const getCatalog = yield* Azure.DevCenter.GetCatalog(project);
 *
 * // runtime
 * const catalog = yield* getCatalog({ catalogName: "templates" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetCatalog extends Binding.Service<
  GetCatalog,
  "Azure.DevCenter.GetCatalog",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetCatalogRequest,
    ) => Effect.Effect<devcenter.Catalog, devcenter.GetEnvironmentCatalogError, RuntimeContext>
  >
> {}

export const GetCatalog = Binding.Service<GetCatalog>("Azure.DevCenter.GetCatalog");
