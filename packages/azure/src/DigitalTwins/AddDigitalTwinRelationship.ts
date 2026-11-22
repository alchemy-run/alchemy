import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface AddDigitalTwinRelationshipRequest extends Omit<
  dt.AddDigitalTwinRelationshipRequest,
  "endpoint"
> {}

/**
 * Create or replace a relationship between two digital twins.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsRelationshipWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/relationships/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddDigitalTwinRelationshipHttp}.
 *
 * ### Calling AddDigitalTwinRelationship
 * **Example:** AddDigitalTwinRelationship from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const addDigitalTwinRelationship = yield* Azure.DigitalTwins.AddDigitalTwinRelationship(twins);
 *
 * // runtime
 * yield* addDigitalTwinRelationship({
 *   id: "floor-1",
 *   relationshipId: "floor-1-room-1",
 *   body: { $relationshipName: "contains", $targetId: "room-1" },
 * });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.AddDigitalTwinRelationshipHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface AddDigitalTwinRelationship extends Binding.Service<
  AddDigitalTwinRelationship,
  "Azure.DigitalTwins.AddDigitalTwinRelationship",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: AddDigitalTwinRelationshipRequest,
    ) => Effect.Effect<
      dt.AddDigitalTwinRelationshipResponse,
      dt.AddDigitalTwinRelationshipError,
      RuntimeContext
    >
  >
> {}

export const AddDigitalTwinRelationship = Binding.Service<AddDigitalTwinRelationship>(
  "Azure.DigitalTwins.AddDigitalTwinRelationship",
);
