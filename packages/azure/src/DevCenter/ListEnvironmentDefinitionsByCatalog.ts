import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListEnvironmentDefinitionsByCatalogRequest extends Omit<
  devcenter.ListEnvironmentEnvironmentDefinitionsByCatalogRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the environment definitions (infrastructure templates) one catalog of
 * the bound Dev Center project publishes (one page; pass `nextLink` for the
 * next) from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterEnvironmentDefinitionReadRole`,
 * one per stack) with exactly the action(s)
 * `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/environmentDefinitions/read`, on the
 * project only. The smallest built-in role, **Deployment Environments User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`). Provide
 * {@link ListEnvironmentDefinitionsByCatalogHttp}.
 *
 * ### Calling ListEnvironmentDefinitionsByCatalog
 * **Example:** ListEnvironmentDefinitionsByCatalog from a Function
 * ```typescript
 * // init
 * const listEnvironmentDefinitionsByCatalog = yield* Azure.DevCenter.ListEnvironmentDefinitionsByCatalog(project);
 *
 * // runtime
 * const page = yield* listEnvironmentDefinitionsByCatalog({ catalogName: "catalog" });
 * const names = page.value.map((definition) => definition.name);
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListEnvironmentDefinitionsByCatalog extends Binding.Service<
  ListEnvironmentDefinitionsByCatalog,
  "Azure.DevCenter.ListEnvironmentDefinitionsByCatalog",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListEnvironmentDefinitionsByCatalogRequest,
    ) => Effect.Effect<
      devcenter.PagedEnvironmentDefinition,
      devcenter.ListEnvironmentEnvironmentDefinitionsByCatalogError,
      RuntimeContext
    >
  >
> {}

export const ListEnvironmentDefinitionsByCatalog =
  Binding.Service<ListEnvironmentDefinitionsByCatalog>(
    "Azure.DevCenter.ListEnvironmentDefinitionsByCatalog",
  );
