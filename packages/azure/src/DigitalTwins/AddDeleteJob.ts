import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface AddDeleteJobRequest extends Omit<dt.AddDeleteJobRequest, "endpoint"> {}

/**
 * Start a job that deletes every model, twin, and relationship on the instance.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsDeleteJobWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/delete/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddDeleteJobHttp}.
 *
 * ### Calling AddDeleteJob
 * **Example:** AddDeleteJob from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const addDeleteJob = yield* Azure.DigitalTwins.AddDeleteJob(twins);
 *
 * // runtime
 * const { operationLocation } = yield* addDeleteJob();
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.AddDeleteJobHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface AddDeleteJob extends Binding.Service<
  AddDeleteJob,
  "Azure.DigitalTwins.AddDeleteJob",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: AddDeleteJobRequest,
    ) => Effect.Effect<dt.AddDeleteJobResponse, dt.AddDeleteJobError, RuntimeContext>
  >
> {}

export const AddDeleteJob = Binding.Service<AddDeleteJob>("Azure.DigitalTwins.AddDeleteJob");
