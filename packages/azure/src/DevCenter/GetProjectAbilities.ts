import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetProjectAbilitiesRequest extends Omit<
  devcenter.GetDevCenterProjectAbilitiesRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Read what a user (the host by default) may do in the bound Dev Center
 * project, as an admin and as a developer, from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterProjectReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`, on
 * the project only. The smallest built-in role, **DevCenter Dev Box User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions. `userId` defaults to `me`: the host acts on its own dev boxes and
 * environments.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetProjectAbilitiesHttp}.
 *
 * ### Calling GetProjectAbilities
 * **Example:** GetProjectAbilities from a Function
 * ```typescript
 * // init
 * const getProjectAbilities = yield* Azure.DevCenter.GetProjectAbilities(project);
 *
 * // runtime
 * const abilities = yield* getProjectAbilities();
 * const canCreate = abilities.abilitiesAsDeveloper.includes("WriteDevBoxes");
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetProjectAbilities extends Binding.Service<
  GetProjectAbilities,
  "Azure.DevCenter.GetProjectAbilities",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: GetProjectAbilitiesRequest,
    ) => Effect.Effect<
      devcenter.ProjectAbilities,
      devcenter.GetDevCenterProjectAbilitiesError,
      RuntimeContext
    >
  >
> {}

export const GetProjectAbilities = Binding.Service<GetProjectAbilities>(
  "Azure.DevCenter.GetProjectAbilities",
);
