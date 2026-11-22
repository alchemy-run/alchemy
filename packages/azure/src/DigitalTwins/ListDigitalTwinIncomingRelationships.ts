import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListDigitalTwinIncomingRelationshipsRequest extends Omit<
  dt.ListDigitalTwinIncomingRelationshipsRequest,
  "endpoint"
> {}

/**
 * List one page of the relationships that point at a digital twin.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsRelationshipReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/relationships/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListDigitalTwinIncomingRelationshipsHttp}.
 *
 * ### Calling ListDigitalTwinIncomingRelationships
 * **Example:** ListDigitalTwinIncomingRelationships from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const listDigitalTwinIncomingRelationships = yield* Azure.DigitalTwins.ListDigitalTwinIncomingRelationships(twins);
 *
 * // runtime
 * const page = yield* listDigitalTwinIncomingRelationships({ id: "room-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.ListDigitalTwinIncomingRelationshipsHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface ListDigitalTwinIncomingRelationships extends Binding.Service<
  ListDigitalTwinIncomingRelationships,
  "Azure.DigitalTwins.ListDigitalTwinIncomingRelationships",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListDigitalTwinIncomingRelationshipsRequest,
    ) => Effect.Effect<
      dt.IncomingRelationshipCollection,
      dt.ListDigitalTwinIncomingRelationshipsError,
      RuntimeContext
    >
  >
> {}

export const ListDigitalTwinIncomingRelationships =
  Binding.Service<ListDigitalTwinIncomingRelationships>(
    "Azure.DigitalTwins.ListDigitalTwinIncomingRelationships",
  );
