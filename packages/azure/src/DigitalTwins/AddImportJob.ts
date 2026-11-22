import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface AddImportJobRequest extends Omit<dt.AddImportJobRequest, "endpoint"> {}

/**
 * Start a bulk import job from an ndjson blob. The instance's identity needs read access to the input blob and write access to the output blob.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsImportJobWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/imports/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddImportJobHttp}.
 *
 * ### Calling AddImportJob
 * **Example:** AddImportJob from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const addImportJob = yield* Azure.DigitalTwins.AddImportJob(twins);
 *
 * // runtime
 * const job = yield* addImportJob({ id: "import-1", inputBlobUri, outputBlobUri });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.AddImportJobHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface AddImportJob extends Binding.Service<
  AddImportJob,
  "Azure.DigitalTwins.AddImportJob",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: AddImportJobRequest,
    ) => Effect.Effect<dt.ImportJob, dt.AddImportJobError, RuntimeContext>
  >
> {}

export const AddImportJob = Binding.Service<AddImportJob>("Azure.DigitalTwins.AddImportJob");
