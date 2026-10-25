import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListEnvironmentDefinitionsRequest extends Omit<
  devcenter.ListEnvironmentEnvironmentDefinitionsByProjectRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the environment definitions (infrastructure templates) the bound Dev
 * Center project's catalogs publish (one page; pass `nextLink` for the next)
 * from any host.
 *
 * Binding assigns a custom role
 * (`AzureDevCenterEnvironmentDefinitionReadRole`, one per stack) with exactly
 * the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/environmentDefinitions/read`, on the
 * project only. The smallest built-in role, **Deployment Environments User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListEnvironmentDefinitionsHttp}.
 *
 * ### Calling ListEnvironmentDefinitions
 * **Example:** ListEnvironmentDefinitions from a Function
 * ```typescript
 * // init
 * const listEnvironmentDefinitions = yield* Azure.DevCenter.ListEnvironmentDefinitions(project);
 *
 * // runtime
 * const page = yield* listEnvironmentDefinitions();
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListEnvironmentDefinitions extends Binding.Service<
  ListEnvironmentDefinitions,
  "Azure.DevCenter.ListEnvironmentDefinitions",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListEnvironmentDefinitionsRequest,
    ) => Effect.Effect<
      devcenter.PagedEnvironmentDefinition,
      devcenter.ListEnvironmentEnvironmentDefinitionsByProjectError,
      RuntimeContext
    >
  >
> {}

export const ListEnvironmentDefinitions = Binding.Service<ListEnvironmentDefinitions>(
  "Azure.DevCenter.ListEnvironmentDefinitions",
);
