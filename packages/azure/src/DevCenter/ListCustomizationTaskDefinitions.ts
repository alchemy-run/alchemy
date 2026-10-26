import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListCustomizationTaskDefinitionsRequest extends Omit<
  devcenter.ListDevBoxCustomizationTaskDefinitionsByProjectRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the customization tasks the bound Dev Center project's catalogs publish
 * (one page; pass `nextLink` for the next) from any host.
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
 * {@link ListCustomizationTaskDefinitionsHttp}.
 *
 * ### Calling ListCustomizationTaskDefinitions
 * **Example:** ListCustomizationTaskDefinitions from a Function
 * ```typescript
 * // init
 * const listCustomizationTaskDefinitions = yield* Azure.DevCenter.ListCustomizationTaskDefinitions(project);
 *
 * // runtime
 * const page = yield* listCustomizationTaskDefinitions();
 * const names = page.value.map((task) => task.name);
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListCustomizationTaskDefinitions extends Binding.Service<
  ListCustomizationTaskDefinitions,
  "Azure.DevCenter.ListCustomizationTaskDefinitions",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListCustomizationTaskDefinitionsRequest,
    ) => Effect.Effect<
      devcenter.PagedCustomizationTaskDefinition,
      devcenter.ListDevBoxCustomizationTaskDefinitionsByProjectError,
      RuntimeContext
    >
  >
> {}

export const ListCustomizationTaskDefinitions = Binding.Service<ListCustomizationTaskDefinitions>(
  "Azure.DevCenter.ListCustomizationTaskDefinitions",
);
