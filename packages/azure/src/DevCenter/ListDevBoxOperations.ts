import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListDevBoxOperationsRequest extends Omit<
  devcenter.ListDevBoxOperationsRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * List the operations (start, stop, repair, snapshot, ...) run on a dev box in
 * the bound Dev Center project (one page; pass `nextLink` for the next) from
 * any host.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxReadRole`, one per stack)
 * with exactly the action(s) `Microsoft.DevCenter/projects/read` and the data
 * action(s) `Microsoft.DevCenter/projects/users/devboxes/userRead/action`, on
 * the project only. The smallest built-in role, **DevCenter Dev Box User**,
 * also grants `Microsoft.DevCenter/projects/*\/read` and its other data
 * actions. `userId` defaults to `me`: the host acts on its own dev boxes. On a
 * host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListDevBoxOperationsHttp}.
 *
 * ### Calling ListDevBoxOperations
 * **Example:** ListDevBoxOperations from a Function
 * ```typescript
 * // init
 * const listDevBoxOperations = yield* Azure.DevCenter.ListDevBoxOperations(project);
 *
 * // runtime
 * const page = yield* listDevBoxOperations({ devBoxName: "ci-box" });
 * const running = page.value.filter((op) => op.status === "Running");
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListDevBoxOperations extends Binding.Service<
  ListDevBoxOperations,
  "Azure.DevCenter.ListDevBoxOperations",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListDevBoxOperationsRequest,
    ) => Effect.Effect<
      devcenter.PagedDevBoxOperation,
      devcenter.ListDevBoxOperationsError,
      RuntimeContext
    >
  >
> {}

export const ListDevBoxOperations = Binding.Service<ListDevBoxOperations>(
  "Azure.DevCenter.ListDevBoxOperations",
);
