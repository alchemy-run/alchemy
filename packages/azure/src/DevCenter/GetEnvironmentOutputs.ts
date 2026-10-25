import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetEnvironmentOutputsRequest extends Omit<
  devcenter.GetEnvironmentOutputsRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Read the outputs of a deployment environment's template in the bound Dev
 * Center project from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterEnvironmentOutputsReadRole`,
 * one per stack) with exactly the action(s)
 * `Microsoft.DevCenter/projects/read` and the data action(s)
 * `Microsoft.DevCenter/projects/users/environments/userOutputsRead/action`,
 * on the project only. The smallest built-in role, **Deployment Environments
 * User**, also grants `Microsoft.DevCenter/projects/*\/read` and its other
 * data actions. `userId` defaults to `me`: the host acts on its own dev boxes
 * and environments.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetEnvironmentOutputsHttp}.
 *
 * ### Calling GetEnvironmentOutputs
 * **Example:** GetEnvironmentOutputs from a Function
 * ```typescript
 * // init
 * const getEnvironmentOutputs = yield* Azure.DevCenter.GetEnvironmentOutputs(project);
 *
 * // runtime
 * const outputs = yield* getEnvironmentOutputs({ environmentName: "pr-42" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetEnvironmentOutputs extends Binding.Service<
  GetEnvironmentOutputs,
  "Azure.DevCenter.GetEnvironmentOutputs",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetEnvironmentOutputsRequest,
    ) => Effect.Effect<
      devcenter.EnvironmentOutputs,
      devcenter.GetEnvironmentOutputsError,
      RuntimeContext
    >
  >
> {}

export const GetEnvironmentOutputs = Binding.Service<GetEnvironmentOutputs>(
  "Azure.DevCenter.GetEnvironmentOutputs",
);
