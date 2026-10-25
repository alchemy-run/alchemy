import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDeleteJobRequest extends Omit<dt.GetDeleteJobByIdRequest, "endpoint"> {}

/**
 * Read a delete job's status.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsDeleteJobReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/delete/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDeleteJobHttp}.
 *
 * ### Calling GetDeleteJob
 * **Example:** GetDeleteJob from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getDeleteJob = yield* Azure.DigitalTwins.GetDeleteJob(twins);
 *
 * // runtime
 * const job = yield* getDeleteJob({ id: jobId });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetDeleteJobHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetDeleteJob extends Binding.Service<
  GetDeleteJob,
  "Azure.DigitalTwins.GetDeleteJob",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDeleteJobRequest,
    ) => Effect.Effect<dt.DeleteJob, dt.GetDeleteJobByIdError, RuntimeContext>
  >
> {}

export const GetDeleteJob = Binding.Service<GetDeleteJob>("Azure.DigitalTwins.GetDeleteJob");
