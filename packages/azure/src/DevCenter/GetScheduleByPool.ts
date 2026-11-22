import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface GetScheduleByPoolRequest extends Omit<
  devcenter.GetDevBoxScheduleByPoolRequest,
  "endpoint" | "projectName"
> {}

/**
 * Read one schedule of a dev box pool of the bound Dev Center project from any
 * host.
 *
 * Binding assigns a custom role (`AzureDevCenterScheduleReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/pools/schedules/read`, on the project only. The
 * smallest built-in role, **DevCenter Dev Box User**, also grants
 * `Microsoft.DevCenter/projects/*\/read` and its other data actions. On a host
 * with a managed identity (an Azure Function, Function App, Web App, Container
 * App, container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra
 * service principal (see `AzureBindings`). Provide
 * {@link GetScheduleByPoolHttp}.
 *
 * ### Calling GetScheduleByPool
 * **Example:** GetScheduleByPool from a Function
 * ```typescript
 * // init
 * const getScheduleByPool = yield* Azure.DevCenter.GetScheduleByPool(project);
 *
 * // runtime
 * const schedule = yield* getScheduleByPool({
 *   poolName: "engineering",
 *   scheduleName: "default",
 * });
 * const stopsAt = `${schedule.time} ${schedule.timeZone}`;
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface GetScheduleByPool extends Binding.Service<
  GetScheduleByPool,
  "Azure.DevCenter.GetScheduleByPool",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: GetScheduleByPoolRequest,
    ) => Effect.Effect<devcenter.Schedule, devcenter.GetDevBoxScheduleByPoolError, RuntimeContext>
  >
> {}

export const GetScheduleByPool = Binding.Service<GetScheduleByPool>(
  "Azure.DevCenter.GetScheduleByPool",
);
