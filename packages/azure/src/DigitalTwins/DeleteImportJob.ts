import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteImportJobRequest extends Omit<dt.DeleteImportJobRequest, "endpoint"> {}

/**
 * Delete an import job record.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsImportJobDeleteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/imports/delete`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteImportJobHttp}.
 *
 * ### Calling DeleteImportJob
 * **Example:** DeleteImportJob from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const deleteImportJob = yield* Azure.DigitalTwins.DeleteImportJob(twins);
 *
 * // runtime
 * yield* deleteImportJob({ id: "import-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.DeleteImportJobHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface DeleteImportJob extends Binding.Service<
  DeleteImportJob,
  "Azure.DigitalTwins.DeleteImportJob",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteImportJobRequest,
    ) => Effect.Effect<dt.DeleteImportJobResponse, dt.DeleteImportJobError, RuntimeContext>
  >
> {}

export const DeleteImportJob = Binding.Service<DeleteImportJob>(
  "Azure.DigitalTwins.DeleteImportJob",
);
