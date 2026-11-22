import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDigitalTwinRelationshipsRequest extends Omit<
  dt.ListDigitalTwinRelationshipsRequest,
  "endpoint"
> {}

/**
 * List one page of a digital twin's outgoing relationships (pass `nextLink` for the next page).
 *
 * Binding assigns a custom role (`AzureDigitalTwinsRelationshipReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/relationships/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListDigitalTwinRelationshipsHttp}.
 *
 * ### Calling ListDigitalTwinRelationships
 * **Example:** ListDigitalTwinRelationships from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const listDigitalTwinRelationships = yield* Azure.DigitalTwins.ListDigitalTwinRelationships(twins);
 *
 * // runtime
 * const page = yield* listDigitalTwinRelationships({ id: "floor-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.ListDigitalTwinRelationshipsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface ListDigitalTwinRelationships extends Binding.Service<
  ListDigitalTwinRelationships,
  "Azure.DigitalTwins.ListDigitalTwinRelationships",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListDigitalTwinRelationshipsRequest,
    ) => Effect.Effect<
      dt.RelationshipCollection,
      dt.ListDigitalTwinRelationshipsError,
      RuntimeContext
    >
  >
> {}

export const ListDigitalTwinRelationships = Binding.Service<ListDigitalTwinRelationships>(
  "Azure.DigitalTwins.ListDigitalTwinRelationships",
);
