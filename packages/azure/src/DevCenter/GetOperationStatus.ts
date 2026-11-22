import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetOperationStatusRequest extends Omit<
  devcenter.GetOperationStatusRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read the status of a long-running operation (the id at the end of an
 * `operationLocation`) in the bound Dev Center project from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterProjectReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions. On
 * a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetOperationStatusHttp}.
 *
 * ### Calling GetOperationStatus
 * **Example:** GetOperationStatus from a Function
 * ```typescript
 * // init
 * const getOperationStatus = yield* Azure.DevCenter.GetOperationStatus(project);
 *
 * // runtime
 * const status = yield* getOperationStatus({ operationId });
 * const done = status.status === "Succeeded";
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetOperationStatus extends Binding.Service<
  GetOperationStatus,
  "Azure.DevCenter.GetOperationStatus",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetOperationStatusRequest,
    ) => Effect.Effect<devcenter.OperationStatus, devcenter.GetOperationStatusError, RuntimeContext>
  >
> {}

export const GetOperationStatus = Binding.Service<GetOperationStatus>(
  "Azure.DevCenter.GetOperationStatus",
);
