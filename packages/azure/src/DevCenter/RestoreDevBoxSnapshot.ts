import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface RestoreDevBoxSnapshotRequest extends Omit<
  devcenter.RestoreDevBoxSnapshotRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Restore a dev box in the bound Dev Center project to one of its snapshots
 * from any host. The restore runs after the call returns.
 *
 * Binding assigns a custom role (`AzureDevCenterDevBoxManageRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read` and the
 * data action(s)
 * `Microsoft.DevCenter/projects/users/devboxes/userWrite/action`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * `userId` defaults to `me`: the host acts on its own dev boxes. On a host with
 * a managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`). Provide
 * {@link RestoreDevBoxSnapshotHttp}.
 *
 * ### Calling RestoreDevBoxSnapshot
 * **Example:** RestoreDevBoxSnapshot from a Function
 * ```typescript
 * // init
 * const restoreDevBoxSnapshot = yield* Azure.DevCenter.RestoreDevBoxSnapshot(project);
 *
 * // runtime
 * yield* restoreDevBoxSnapshot({ devBoxName: "ci-box", snapshotId });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface RestoreDevBoxSnapshot extends Binding.Service<
  RestoreDevBoxSnapshot,
  "Azure.DevCenter.RestoreDevBoxSnapshot",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: RestoreDevBoxSnapshotRequest,
    ) => Effect.Effect<
      devcenter.RestoreDevBoxSnapshotResponse,
      devcenter.RestoreDevBoxSnapshotError,
      RuntimeContext
    >
  >
> {}

export const RestoreDevBoxSnapshot = Binding.Service<RestoreDevBoxSnapshot>(
  "Azure.DevCenter.RestoreDevBoxSnapshot",
);
