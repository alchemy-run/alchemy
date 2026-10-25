import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetImportJobRequest extends Omit<dt.GetImportJobByIdRequest, "endpoint"> {}

/**
 * Read an import job's status.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsImportJobReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/imports/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetImportJobHttp}.
 *
 * ### Calling GetImportJob
 * **Example:** GetImportJob from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getImportJob = yield* Azure.DigitalTwins.GetImportJob(twins);
 *
 * // runtime
 * const job = yield* getImportJob({ id: "import-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetImportJobHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetImportJob extends Binding.Service<
  GetImportJob,
  "Azure.DigitalTwins.GetImportJob",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetImportJobRequest,
    ) => Effect.Effect<dt.ImportJob, dt.GetImportJobByIdError, RuntimeContext>
  >
> {}

export const GetImportJob = Binding.Service<GetImportJob>("Azure.DigitalTwins.GetImportJob");
