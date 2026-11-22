import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetImagingTaskLogRequest extends Omit<
  devcenter.GetDevBoxImagingTaskLogRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read the log of an image build of the bound Dev Center project's image
 * definitions from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterImageBuildReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/catalogs/imageDefinitions/builds/read`, on the
 * project only. The smallest built-in role, **DevCenter Dev Box User**, also
 * grants `Microsoft.DevCenter/projects/*\/read` and its other data actions. On
 * a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetImagingTaskLogHttp}.
 *
 * ### Calling GetImagingTaskLog
 * **Example:** GetImagingTaskLog from a Function
 * ```typescript
 * // init
 * const getImagingTaskLog = yield* Azure.DevCenter.GetImagingTaskLog(project);
 *
 * // runtime
 * const log = yield* getImagingTaskLog({ imageBuildLogId });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetImagingTaskLog extends Binding.Service<
  GetImagingTaskLog,
  "Azure.DevCenter.GetImagingTaskLog",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetImagingTaskLogRequest,
    ) => Effect.Effect<
      devcenter.GetDevBoxImagingTaskLogResponse,
      devcenter.GetDevBoxImagingTaskLogError,
      RuntimeContext
    >
  >
> {}

export const GetImagingTaskLog = Binding.Service<GetImagingTaskLog>(
  "Azure.DevCenter.GetImagingTaskLog",
);
