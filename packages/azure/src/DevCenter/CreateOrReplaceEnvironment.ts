import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CreateOrReplaceEnvironmentRequest extends Omit<
  devcenter.EnvironmentsCreateOrReplaceEnvironmentRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Create or replace a deployment environment from a catalog's environment
 * definition in the bound Dev Center project from any host. The deployment
 * runs after the call returns and creates Azure resources in the environment
 * type's target subscription.
 *
 * Binding assigns a custom role (`AzureDevCenterEnvironmentWriteRole`, one
 * per stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/read`,
 * `Microsoft.DevCenter/projects/catalogs/environmentDefinitions/read`,
 * `Microsoft.DevCenter/projects/environmentTypes/read` and the data action(s)
 * `Microsoft.DevCenter/projects/users/environments/userWrite/action`, on the
 * project only. The smallest built-in role, **Deployment Environments User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions. `userId` defaults to `me`: the host acts on its own dev boxes and
 * environments.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CreateOrReplaceEnvironmentHttp}.
 *
 * ### Calling CreateOrReplaceEnvironment
 * **Example:** CreateOrReplaceEnvironment from a Function
 * ```typescript
 * // init
 * const createOrReplaceEnvironment = yield* Azure.DevCenter.CreateOrReplaceEnvironment(project);
 *
 * // runtime
 * yield* createOrReplaceEnvironment({
 *   environmentName: "pr-42",
 *   environmentType: "dev",
 *   catalogName: "templates",
 *   environmentDefinitionName: "Sandbox",
 * });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface CreateOrReplaceEnvironment extends Binding.Service<
  CreateOrReplaceEnvironment,
  "Azure.DevCenter.CreateOrReplaceEnvironment",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CreateOrReplaceEnvironmentRequest,
    ) => Effect.Effect<
      devcenter.EnvironmentsCreateOrReplaceEnvironmentResponse,
      devcenter.EnvironmentsCreateOrReplaceEnvironmentError,
      RuntimeContext
    >
  >
> {}

export const CreateOrReplaceEnvironment = Binding.Service<CreateOrReplaceEnvironment>(
  "Azure.DevCenter.CreateOrReplaceEnvironment",
);
