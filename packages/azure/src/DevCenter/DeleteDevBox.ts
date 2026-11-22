import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DeleteDevBoxRequest extends Omit<
  devcenter.DeleteDevBoxDevBoxRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Delete a dev box in the bound Dev Center project from any host. The delete
 * runs after the call returns.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxDeleteRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read` and
 * the data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userDelete/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * `userId` defaults to `me`: the host acts on its own dev boxes and
 * environments.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDevBoxHttp}.
 *
 * ### Calling DeleteDevBox
 * **Example:** DeleteDevBox from a Function
 * ```typescript
 * // init
 * const deleteDevBox = yield* Azure.DevCenter.DeleteDevBox(project);
 *
 * // runtime
 * yield* deleteDevBox({ devBoxName: "ci-box" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface DeleteDevBox extends Binding.Service<
  DeleteDevBox,
  "Azure.DevCenter.DeleteDevBox",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DeleteDevBoxRequest,
    ) => Effect.Effect<
      devcenter.DeleteDevBoxDevBoxResponse,
      devcenter.DeleteDevBoxDevBoxError,
      RuntimeContext
    >
  >
> {}

export const DeleteDevBox = Binding.Service<DeleteDevBox>("Azure.DevCenter.DeleteDevBox");
