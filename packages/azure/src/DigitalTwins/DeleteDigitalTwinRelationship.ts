import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteDigitalTwinRelationshipRequest extends Omit<
  dt.DeleteDigitalTwinRelationshipRequest,
  "endpoint"
> {}

/**
 * Delete a relationship of a digital twin.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsRelationshipDeleteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/relationships/delete`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteDigitalTwinRelationshipHttp}.
 *
 * ### Calling DeleteDigitalTwinRelationship
 * **Example:** DeleteDigitalTwinRelationship from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const deleteDigitalTwinRelationship = yield* Azure.DigitalTwins.DeleteDigitalTwinRelationship(twins);
 *
 * // runtime
 * yield* deleteDigitalTwinRelationship({ id: "floor-1", relationshipId: "floor-1-room-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.DeleteDigitalTwinRelationshipHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface DeleteDigitalTwinRelationship extends Binding.Service<
  DeleteDigitalTwinRelationship,
  "Azure.DigitalTwins.DeleteDigitalTwinRelationship",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteDigitalTwinRelationshipRequest,
    ) => Effect.Effect<
      dt.DeleteDigitalTwinRelationshipResponse,
      dt.DeleteDigitalTwinRelationshipError,
      RuntimeContext
    >
  >
> {}

export const DeleteDigitalTwinRelationship = Binding.Service<DeleteDigitalTwinRelationship>(
  "Azure.DigitalTwins.DeleteDigitalTwinRelationship",
);
