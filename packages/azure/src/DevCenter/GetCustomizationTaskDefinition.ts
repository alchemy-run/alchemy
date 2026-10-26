import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetCustomizationTaskDefinitionRequest extends Omit<
  devcenter.GetDevBoxCustomizationTaskDefinitionsRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read a customization task (its parameters) that a catalog of the bound Dev
 * Center project publishes from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterCatalogReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/read`, on the project only. The
 * smallest built-in role, **DevCenter Dev Box User**, also grants
 * `Microsoft.DevCenter/projects/*\/read` and its other data actions. On a host
 * with a managed identity (an Azure Function, Function App, Web App, Container
 * App, container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`). Provide
 * {@link GetCustomizationTaskDefinitionHttp}.
 *
 * ### Calling GetCustomizationTaskDefinition
 * **Example:** GetCustomizationTaskDefinition from a Function
 * ```typescript
 * // init
 * const getCustomizationTaskDefinition = yield* Azure.DevCenter.GetCustomizationTaskDefinition(project);
 *
 * // runtime
 * const task = yield* getCustomizationTaskDefinition({
 *   catalogName: "catalog",
 *   taskName: "catalog/winget",
 * });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetCustomizationTaskDefinition extends Binding.Service<
  GetCustomizationTaskDefinition,
  "Azure.DevCenter.GetCustomizationTaskDefinition",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetCustomizationTaskDefinitionRequest,
    ) => Effect.Effect<
      devcenter.CustomizationTaskDefinition,
      devcenter.GetDevBoxCustomizationTaskDefinitionsError,
      RuntimeContext
    >
  >
> {}

export const GetCustomizationTaskDefinition = Binding.Service<GetCustomizationTaskDefinition>(
  "Azure.DevCenter.GetCustomizationTaskDefinition",
);
