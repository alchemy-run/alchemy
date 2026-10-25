import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListSchedulesRequest extends Omit<
  devcenter.ListDevBoxSchedulesByProjectRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the dev box pool schedules (auto-stop times) of the bound Dev Center
 * project (one page; pass `nextLink` for the next) from any host.
 *
 * Binding assigns a custom role (`AzureDevCenterScheduleReadRole`, one per
 * stack) with exactly the action(s) `Microsoft.DevCenter/projects/read`,
 * `Microsoft.DevCenter/projects/pools/schedules/read`, on the project only.
 * The smallest built-in role, **DevCenter Dev Box User**, also grants
 * `Microsoft.DevCenter/projects/*\/read` and its other data actions.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListSchedulesHttp}.
 *
 * ### Calling ListSchedules
 * **Example:** ListSchedules from a Function
 * ```typescript
 * // init
 * const listSchedules = yield* Azure.DevCenter.ListSchedules(project);
 *
 * // runtime
 * const page = yield* listSchedules();
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListSchedules extends Binding.Service<
  ListSchedules,
  "Azure.DevCenter.ListSchedules",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request?: ListSchedulesRequest,
    ) => Effect.Effect<
      devcenter.PagedSchedule,
      devcenter.ListDevBoxSchedulesByProjectError,
      RuntimeContext
    >
  >
> {}

export const ListSchedules = Binding.Service<ListSchedules>("Azure.DevCenter.ListSchedules");
