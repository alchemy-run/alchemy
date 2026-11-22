import type * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetDigitalTwinRelationshipRequest extends Omit<
  dt.GetDigitalTwinRelationshipByIdRequest,
  "endpoint"
> {}

/**
 * Read a relationship of a digital twin.
 *
 * Binding assigns a custom role (`AzureDigitalTwinsRelationshipReadRole`, one per
 * stack) with exactly the data action `Microsoft.DigitalTwins/digitaltwins/relationships/read`, on
 * the bound instance only (the built-in Azure Digital Twins Data Reader /
 * Data Owner roles grant every read / every action).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetDigitalTwinRelationshipHttp}.
 *
 * ### Calling GetDigitalTwinRelationship
 * **Example:** GetDigitalTwinRelationship from a Function
 * ```typescript
 * // init
 * const twins = yield* Azure.DigitalTwins.Instance("factory");
 * const getDigitalTwinRelationship = yield* Azure.DigitalTwins.GetDigitalTwinRelationship(twins);
 *
 * // runtime
 * const rel = yield* getDigitalTwinRelationship({ id: "floor-1", relationshipId: "floor-1-room-1" });
 *
 * // layer
 * Effect.provide(Azure.DigitalTwins.GetDigitalTwinRelationshipHttp)
 * ```
 *
 * @binding
 * @category DigitalTwins
 */
export interface GetDigitalTwinRelationship extends Binding.Service<
  GetDigitalTwinRelationship,
  "Azure.DigitalTwins.GetDigitalTwinRelationship",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetDigitalTwinRelationshipRequest,
    ) => Effect.Effect<
      dt.GetDigitalTwinRelationshipByIdResponse,
      dt.GetDigitalTwinRelationshipByIdError,
      RuntimeContext
    >
  >
> {}

export const GetDigitalTwinRelationship = Binding.Service<GetDigitalTwinRelationship>(
  "Azure.DigitalTwins.GetDigitalTwinRelationship",
);
