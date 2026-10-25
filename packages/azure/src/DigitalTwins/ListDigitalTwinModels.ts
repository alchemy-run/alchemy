import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDigitalTwinModelsRequest extends Omit<
  dt.ListDigitalTwinModelsRequest,
  "endpoint"
> {}

/**
 * List one page of the instance's models.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsModelReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/models/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListDigitalTwinModelsHttp}.
 *
 * ### Calling ListDigitalTwinModels
 * **Example:** ListDigitalTwinModels from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const listDigitalTwinModels = yield* Azure.DigitalTwins.ListDigitalTwinModels(twins);
 *
 * // runtime
 * const page = yield* listDigitalTwinModels();
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.ListDigitalTwinModelsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface ListDigitalTwinModels extends Binding.Service<
  ListDigitalTwinModels,
  "Azure.DigitalTwins.ListDigitalTwinModels",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListDigitalTwinModelsRequest,
    ) => Effect.Effect<
      dt.PagedDigitalTwinsModelDataCollection,
      dt.ListDigitalTwinModelsError,
      RuntimeContext
    >
  >
> {}

export const ListDigitalTwinModels = Binding.Service<ListDigitalTwinModels>(
  "Azure.DigitalTwins.ListDigitalTwinModels",
);
