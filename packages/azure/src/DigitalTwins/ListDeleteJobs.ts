import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDeleteJobsRequest extends Omit<dt.ListDeleteJobsRequest, "endpoint"> {}

/**
 * List one page of the instance's delete jobs.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsDeleteJobReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/delete/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListDeleteJobsHttp}.
 *
 * ### Calling ListDeleteJobs
 * **Example:** ListDeleteJobs from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const listDeleteJobs = yield* Azure.DigitalTwins.ListDeleteJobs(twins);
 *
 * // runtime
 * const page = yield* listDeleteJobs();
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.ListDeleteJobsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface ListDeleteJobs extends Binding.Service<
  ListDeleteJobs,
  "Azure.DigitalTwins.ListDeleteJobs",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListDeleteJobsRequest,
    ) => Effect.Effect<dt.DeleteJobCollection, dt.ListDeleteJobsError, RuntimeContext>
  >
> {}

export const ListDeleteJobs = Binding.Service<ListDeleteJobs>("Azure.DigitalTwins.ListDeleteJobs");
