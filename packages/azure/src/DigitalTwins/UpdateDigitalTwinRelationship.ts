import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateDigitalTwinRelationshipRequest extends Omit<
  dt.UpdateDigitalTwinRelationshipRequest,
  "endpoint"
> {}

/**
 * Update a relationship's properties with a JSON Patch document.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsRelationshipWriteRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/relationships/write`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateDigitalTwinRelationshipHttp}.
 *
 * ### Calling UpdateDigitalTwinRelationship
 * **Example:** UpdateDigitalTwinRelationship from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const updateDigitalTwinRelationship = yield* Azure.DigitalTwins.UpdateDigitalTwinRelationship(twins);
 *
 * // runtime
 * yield* updateDigitalTwinRelationship({
 *   id: "floor-1",
 *   relationshipId: "floor-1-room-1",
 *   body: [{ op: "add", path: "/since", value: "2026-01-01" }],
 * });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.UpdateDigitalTwinRelationshipHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface UpdateDigitalTwinRelationship extends Binding.Service<
  UpdateDigitalTwinRelationship,
  "Azure.DigitalTwins.UpdateDigitalTwinRelationship",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateDigitalTwinRelationshipRequest,
    ) => Effect.Effect<
      dt.UpdateDigitalTwinRelationshipResponse,
      dt.UpdateDigitalTwinRelationshipError,
      RuntimeContext
    >
  >
> {}

export const UpdateDigitalTwinRelationship = Binding.Service<UpdateDigitalTwinRelationship>(
  "Azure.DigitalTwins.UpdateDigitalTwinRelationship",
);
