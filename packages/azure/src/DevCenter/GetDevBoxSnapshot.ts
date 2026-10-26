import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetDevBoxSnapshotRequest extends Omit<
  devcenter.GetDevBoxSnapshotRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Read one snapshot of a dev box in the bound Dev Center project from any host.
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
 * {@link GetDevBoxSnapshotHttp}.
 *
 * ### Calling GetDevBoxSnapshot
 * **Example:** GetDevBoxSnapshot from a Function
 * ```typescript
 * // init
 * const getDevBoxSnapshot = yield* Azure.DevCenter.GetDevBoxSnapshot(project);
 *
 * // runtime
 * const snapshot = yield* getDevBoxSnapshot({ devBoxName: "ci-box", snapshotId });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetDevBoxSnapshot extends Binding.Service<
  GetDevBoxSnapshot,
  "Azure.DevCenter.GetDevBoxSnapshot",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetDevBoxSnapshotRequest,
    ) => Effect.Effect<devcenter.DevBoxSnapshot, devcenter.GetDevBoxSnapshotError, RuntimeContext>
  >
> {}

export const GetDevBoxSnapshot = Binding.Service<GetDevBoxSnapshot>(
  "Azure.DevCenter.GetDevBoxSnapshot",
);
