import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CancelImportJobRequest extends Omit<dt.CancelImportJobRequest, "endpoint"> {}

/**
 * Cancel a running import job.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsImportJobCancelRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/imports/cancel/action`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelImportJobHttp}.
 *
 * ### Calling CancelImportJob
 * **Example:** CancelImportJob from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const cancelImportJob = yield* Azure.DigitalTwins.CancelImportJob(twins);
 *
 * // runtime
 * const job = yield* cancelImportJob({ id: "import-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.CancelImportJobHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface CancelImportJob extends Binding.Service<
  CancelImportJob,
  "Azure.DigitalTwins.CancelImportJob",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CancelImportJobRequest,
    ) => Effect.Effect<dt.ImportJob, dt.CancelImportJobError, RuntimeContext>
  >
> {}

export const CancelImportJob = Binding.Service<CancelImportJob>(
  "Azure.DigitalTwins.CancelImportJob",
);
