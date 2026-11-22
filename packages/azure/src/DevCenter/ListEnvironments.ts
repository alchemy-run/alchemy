import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListEnvironmentsRequest extends Omit<
  devcenter.ListEnvironmentEnvironmentsByUserRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * List a user's deployment environments (the host's own by default) in the
 * bound Dev Center project (one page; pass `nextLink` for the next) from any
 * host.
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
 * Provide {@link ListEnvironmentsHttp}.
 *
 * ### Calling ListEnvironments
 * **Example:** ListEnvironments from a Function
 * ```typescript
 * // init
 * const listEnvironments = yield* Azure.DevCenter.ListEnvironments(project);
 *
 * // runtime
 * const page = yield* listEnvironments();
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListEnvironments extends Binding.Service<
  ListEnvironments,
  "Azure.DevCenter.ListEnvironments",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListEnvironmentsRequest,
    ) => Effect.Effect<
      devcenter.PagedEnvironment,
      devcenter.ListEnvironmentEnvironmentsByUserError,
      RuntimeContext
    >
  >
> {}

export const ListEnvironments = Binding.Service<ListEnvironments>(
  "Azure.DevCenter.ListEnvironments",
);
