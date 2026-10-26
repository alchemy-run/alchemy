import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ValidateCustomizationTasksRequest extends Omit<
  devcenter.ValidateDevBoxCustomizationTasksActionRequest,
  "endpoint" | "projectName"
> {}

/**
 * Validate a list of customization tasks against the bound Dev Center project's
 * catalogs from any host. The validation runs after the call returns; poll
 * `operationLocation` with `GetOperationStatus`.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxCustomizeRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/read` and the data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userCustomize/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions. On
 * a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ValidateCustomizationTasksHttp}.
 *
 * ### Calling ValidateCustomizationTasks
 * **Example:** ValidateCustomizationTasks from a Function
 * ```typescript
 * // init
 * const validateCustomizationTasks = yield* Azure.DevCenter.ValidateCustomizationTasks(project);
 *
 * // runtime
 * const { operationLocation } = yield* validateCustomizationTasks({
 *   tasks: [{ name: "catalog/winget", parameters: { package: "Git.Git" } }],
 * });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ValidateCustomizationTasks extends Binding.Service<
  ValidateCustomizationTasks,
  "Azure.DevCenter.ValidateCustomizationTasks",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ValidateCustomizationTasksRequest,
    ) => Effect.Effect<
      devcenter.ValidateDevBoxCustomizationTasksActionResponse,
      devcenter.ValidateDevBoxCustomizationTasksActionError,
      RuntimeContext
    >
  >
> {}

export const ValidateCustomizationTasks = Binding.Service<ValidateCustomizationTasks>(
  "Azure.DevCenter.ValidateCustomizationTasks",
);
