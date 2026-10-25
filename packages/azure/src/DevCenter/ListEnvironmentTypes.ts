import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListEnvironmentTypesRequest extends Omit<
  devcenter.ListEnvironmentEnvironmentTypesRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the environment types (deployment targets) of the bound Dev Center
 * project (one page; pass `nextLink` for the next) from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterEnvironmentTypeReadRole`, one
 * per stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/environmentTypes/read`, on the project only.
 * The smallest built-in role, **Deployment Environments User**, also grants
 * `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListEnvironmentTypesHttp}.
 *
 * ### Calling ListEnvironmentTypes
 * **Example:** ListEnvironmentTypes from a Function
 * ```typescript
 * // init
 * const listEnvironmentTypes = yield* Azure.DevCenter.ListEnvironmentTypes(project);
 *
 * // runtime
 * const page = yield* listEnvironmentTypes();
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListEnvironmentTypes extends Binding.Service<
  ListEnvironmentTypes,
  "Azure.DevCenter.ListEnvironmentTypes",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListEnvironmentTypesRequest,
    ) => Effect.Effect<
      devcenter.PagedEnvironmentType,
      devcenter.ListEnvironmentEnvironmentTypesError,
      RuntimeContext
    >
  >
> {}

export const ListEnvironmentTypes = Binding.Service<ListEnvironmentTypes>(
  "Azure.DevCenter.ListEnvironmentTypes",
);
