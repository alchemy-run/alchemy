import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListImportJobsRequest extends Omit<dt.ListImportJobsRequest, "endpoint"> {}

/**
 * List one page of the instance's import jobs.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsImportJobReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/jobs/imports/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListImportJobsHttp}.
 *
 * ### Calling ListImportJobs
 * **Example:** ListImportJobs from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const listImportJobs = yield* Azure.DigitalTwins.ListImportJobs(twins);
 *
 * // runtime
 * const page = yield* listImportJobs();
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.ListImportJobsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface ListImportJobs extends Binding.Service<
  ListImportJobs,
  "Azure.DigitalTwins.ListImportJobs",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListImportJobsRequest,
    ) => Effect.Effect<dt.ImportJobCollection, dt.ListImportJobsError, RuntimeContext>
  >
> {}

export const ListImportJobs = Binding.Service<ListImportJobs>("Azure.DigitalTwins.ListImportJobs");
