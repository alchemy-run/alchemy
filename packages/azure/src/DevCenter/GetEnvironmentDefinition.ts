import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetEnvironmentDefinitionRequest extends Omit<
  devcenter.GetEnvironmentEnvironmentDefinitionRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read an environment definition (its template and parameters) from a catalog
 * of the bound Dev Center project from any host.
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
 * Provide {@link GetEnvironmentDefinitionHttp}.
 *
 * ### Calling GetEnvironmentDefinition
 * **Example:** GetEnvironmentDefinition from a Function
 * ```typescript
 * // init
 * const getEnvironmentDefinition = yield* Azure.DevCenter.GetEnvironmentDefinition(project);
 *
 * // runtime
 * const definition = yield* getEnvironmentDefinition({
 *   catalogName: "templates",
 *   definitionName: "Sandbox",
 * });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetEnvironmentDefinition extends Binding.Service<
  GetEnvironmentDefinition,
  "Azure.DevCenter.GetEnvironmentDefinition",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetEnvironmentDefinitionRequest,
    ) => Effect.Effect<
      devcenter.EnvironmentDefinition,
      devcenter.GetEnvironmentEnvironmentDefinitionError,
      RuntimeContext
    >
  >
> {}

export const GetEnvironmentDefinition = Binding.Service<GetEnvironmentDefinition>(
  "Azure.DevCenter.GetEnvironmentDefinition",
);
