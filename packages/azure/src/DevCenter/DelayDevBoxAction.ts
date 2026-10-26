import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DelayDevBoxActionRequest extends Omit<
  devcenter.DevBoxesDelayActionRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Delay a scheduled action of a dev box in the bound Dev Center project until a
 * later time from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxActionManageRole`, one
 * per stack) with exactly the action(s) `Microsoft.DevCenter/projects/read` and
 * the data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userActionManage/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * `userId` defaults to `me`: the host acts on its own dev boxes. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`). Provide
 * {@link DelayDevBoxActionHttp}.
 *
 * ### Calling DelayDevBoxAction
 * **Example:** DelayDevBoxAction from a Function
 * ```typescript
 * // init
 * const delayDevBoxAction = yield* Azure.DevCenter.DelayDevBoxAction(project);
 *
 * // runtime
 * const action = yield* delayDevBoxAction({
 *   devBoxName: "ci-box",
 *   actionName: "schedule-default",
 *   until: "2026-10-27T01:00:00Z",
 * });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface DelayDevBoxAction extends Binding.Service<
  DelayDevBoxAction,
  "Azure.DevCenter.DelayDevBoxAction",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DelayDevBoxActionRequest,
    ) => Effect.Effect<devcenter.DevBoxAction, devcenter.DevBoxesDelayActionError, RuntimeContext>
  >
> {}

export const DelayDevBoxAction = Binding.Service<DelayDevBoxAction>(
  "Azure.DevCenter.DelayDevBoxAction",
);
