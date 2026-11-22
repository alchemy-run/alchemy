import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface CaptureDevBoxSnapshotRequest extends Omit<
  devcenter.CaptureDevBoxSnapshotRequest,
  "endpoint" | "projectName" | "userId"
> {
  /**
   * User object ID, or `me` for the host's own identity.
   * @default "me"
   */
  userId?: string;
}

/**
 * Capture a manual snapshot of a dev box in the bound Dev Center project from
 * any host. The capture runs after the call returns; poll `operationLocation`
 * or list the snapshots for its id.
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
 * {@link CaptureDevBoxSnapshotHttp}.
 *
 * ### Calling CaptureDevBoxSnapshot
 * **Example:** CaptureDevBoxSnapshot from a Function
 * ```typescript
 * // init
 * const captureDevBoxSnapshot = yield* Azure.DevCenter.CaptureDevBoxSnapshot(project);
 *
 * // runtime
 * const { operationLocation } = yield* captureDevBoxSnapshot({ devBoxName: "ci-box" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface CaptureDevBoxSnapshot extends Binding.Service<
  CaptureDevBoxSnapshot,
  "Azure.DevCenter.CaptureDevBoxSnapshot",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: CaptureDevBoxSnapshotRequest,
    ) => Effect.Effect<
      devcenter.CaptureDevBoxSnapshotResponse,
      devcenter.CaptureDevBoxSnapshotError,
      RuntimeContext
    >
  >
> {}

export const CaptureDevBoxSnapshot = Binding.Service<CaptureDevBoxSnapshot>(
  "Azure.DevCenter.CaptureDevBoxSnapshot",
);
