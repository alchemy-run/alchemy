import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface DelayDevBoxActionsRequest extends Omit<
  devcenter.DevBoxesDelayActionsRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Delay every scheduled action of a dev box in the bound Dev Center project
 * until a later time from any host (one page of results; pass `nextLink` for
 * the next).
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
 * {@link DelayDevBoxActionsHttp}.
 *
 * ### Calling DelayDevBoxActions
 * **Example:** DelayDevBoxActions from a Function
 * ```typescript
 * // init
 * const delayDevBoxActions = yield* Azure.DevCenter.DelayDevBoxActions(project);
 *
 * // runtime
 * const page = yield* delayDevBoxActions({ devBoxName: "ci-box", until: "2026-10-27T01:00:00Z" });
 * const failed = page.value.filter((result) => result.result === "Failed");
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface DelayDevBoxActions extends Binding.Service<
  DelayDevBoxActions,
  "Azure.DevCenter.DelayDevBoxActions",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: DelayDevBoxActionsRequest,
    ) => Effect.Effect<
      devcenter.PagedDevBoxActionDelayResult,
      devcenter.DevBoxesDelayActionsError,
      RuntimeContext
    >
  >
> {}

export const DelayDevBoxActions = Binding.Service<DelayDevBoxActions>(
  "Azure.DevCenter.DelayDevBoxActions",
);
