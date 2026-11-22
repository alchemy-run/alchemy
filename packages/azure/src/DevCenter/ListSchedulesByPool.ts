import type * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

export interface ListSchedulesByPoolRequest extends Omit<
  devcenter.ListDevBoxSchedulesByPoolRequest,
  "endpoint" | "projectName"
> {}

/**
 * List the schedules (for example the nightly auto-stop) of one dev box pool of
 * the bound Dev Center project (one page; pass `nextLink` for the next) from
 * any host.
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
 * {@link ListSchedulesByPoolHttp}.
 *
 * ### Calling ListSchedulesByPool
 * **Example:** ListSchedulesByPool from a Function
 * ```typescript
 * // init
 * const listSchedulesByPool = yield* Azure.DevCenter.ListSchedulesByPool(project);
 *
 * // runtime
 * const page = yield* listSchedulesByPool({ poolName: "engineering" });
 * ```
 *
 * @binding
 * @category DevCenter
 */
export interface ListSchedulesByPool extends Binding.Service<
  ListSchedulesByPool,
  "Azure.DevCenter.ListSchedulesByPool",
  (
    project: Project,
  ) => Effect.Effect<
    (
      request: ListSchedulesByPoolRequest,
    ) => Effect.Effect<
      devcenter.PagedSchedule,
      devcenter.ListDevBoxSchedulesByPoolError,
      RuntimeContext
    >
  >
> {}

export const ListSchedulesByPool = Binding.Service<ListSchedulesByPool>(
  "Azure.DevCenter.ListSchedulesByPool",
);
