import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetEnvironmentRequest extends Omit<
  devcenter.GetEnvironmentEnvironmentByUserRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Read a deployment environment (its definition, parameters, and provisioning
 * state) in the bound Dev Center project from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterEnvironmentReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read` and
 * the data action(s)
 * `Microsoft.DevCenter/projects/users/environments/userRead/action`, on the
 * project only. The smallest built-in role, **Deployment Environments User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions. `userId` defaults to `me`: the host acts on its own dev boxes and
 * environments.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetEnvironmentHttp}.
 *
 * ### Calling GetEnvironment
 * **Example:** GetEnvironment from a Function
 * ```typescript
 * // init
 * const getEnvironment = yield* Azure.DevCenter.GetEnvironment(project);
 *
 * // runtime
 * const environment = yield* getEnvironment({ environmentName: "pr-42" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetEnvironment extends Binding.Service<
  GetEnvironment,
  "Azure.DevCenter.GetEnvironment",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetEnvironmentRequest,
    ) => Effect.Effect<
      devcenter.Environment,
      devcenter.GetEnvironmentEnvironmentByUserError,
      RuntimeContext
    >
  >
> {}

export const GetEnvironment = Binding.Service<GetEnvironment>("Azure.DevCenter.GetEnvironment");
