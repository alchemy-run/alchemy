import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface StartDevBoxRequest extends Omit<
  devcenter.StartDevBoxDevBoxRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Start a stopped dev box in the bound Dev Center project from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxStartRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read` and
 * the data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userStart/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * `userId` defaults to `me`: the host acts on its own dev boxes and
 * environments.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartDevBoxHttp}.
 *
 * ### Calling StartDevBox
 * **Example:** StartDevBox from a Function
 * ```typescript
 * // init
 * const startDevBox = yield* Azure.DevCenter.StartDevBox(project);
 *
 * // runtime
 * yield* startDevBox({ devBoxName: "ci-box" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface StartDevBox extends Binding.Service<
  StartDevBox,
  "Azure.DevCenter.StartDevBox",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: StartDevBoxRequest,
    ) => Effect.Effect<
      devcenter.StartDevBoxDevBoxResponse,
      devcenter.StartDevBoxDevBoxError,
      RuntimeContext
    >
  >
> {}

export const StartDevBox = Binding.Service<StartDevBox>("Azure.DevCenter.StartDevBox");
