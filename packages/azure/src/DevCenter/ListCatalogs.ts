import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListCatalogsRequest extends Omit<
  devcenter.ListEnvironmentCatalogsByProjectRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the catalogs of the bound Dev Center project (one page; pass
 * `nextLink` for the next) from any host.
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
 * Provide {@link ListCatalogsHttp}.
 *
 * ### Calling ListCatalogs
 * **Example:** ListCatalogs from a Function
 * ```typescript
 * // init
 * const listCatalogs = yield* Azure.DevCenter.ListCatalogs(project);
 *
 * // runtime
 * const page = yield* listCatalogs();
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListCatalogs extends Binding.Service<
  ListCatalogs,
  "Azure.DevCenter.ListCatalogs",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListCatalogsRequest,
    ) => Effect.Effect<
      devcenter.PagedCatalog,
      devcenter.ListEnvironmentCatalogsByProjectError,
      RuntimeContext
    >
  >
> {}

export const ListCatalogs = Binding.Service<ListCatalogs>("Azure.DevCenter.ListCatalogs");
