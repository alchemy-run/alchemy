import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListDevBoxActionsRequest extends Omit<
  devcenter.ListDevBoxActionsRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * List the scheduled actions (for example the nightly auto-stop) of a dev box
 * in the bound Dev Center project (one page; pass `nextLink` for the next) from
 * any host.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxActionReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read` and the
 * data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userActionRead/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * `userId` defaults to `me`: the host acts on its own dev boxes. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`). Provide
 * {@link ListDevBoxActionsHttp}.
 *
 * ### Calling ListDevBoxActions
 * **Example:** ListDevBoxActions from a Function
 * ```typescript
 * // init
 * const listDevBoxActions = yield* Azure.DevCenter.ListDevBoxActions(project);
 *
 * // runtime
 * const page = yield* listDevBoxActions({ devBoxName: "ci-box" });
 * const next = page.value[0]?.next?.scheduledTime;
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListDevBoxActions extends Binding.Service<
  ListDevBoxActions,
  "Azure.DevCenter.ListDevBoxActions",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListDevBoxActionsRequest,
    ) => Effect.Effect<
      devcenter.PagedDevBoxAction,
      devcenter.ListDevBoxActionsError,
      RuntimeContext
    >
  >
> {}

export const ListDevBoxActions = Binding.Service<ListDevBoxActions>(
  "Azure.DevCenter.ListDevBoxActions",
);
