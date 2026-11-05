import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFleetWiseAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `BatchUpdateVehicle` operation (IAM action
 * `iotfleetwise:BatchUpdateVehicle`), account-level.
 *
 * Updates up to 10 vehicles in one call — attributes, manifest
 * associations, and state-template associations. Per-item failures are
 * returned in the response `errors` list, not the error channel. Provide
 * the implementation with
 * `Effect.provide(AWS.IoTFleetWise.BatchUpdateVehicleHttp)`.
 *
 * ### Provisioning Vehicles
 * **Example:** Update a Batch of Vehicle Attributes
 * ```typescript
 * const batchUpdateVehicle = yield* IoTFleetWise.BatchUpdateVehicle();
 *
 * yield* batchUpdateVehicle({
 *   vehicles: [
 *     {
 *       vehicleName: "vin-1HGBH41JXMN109186",
 *       attributes: { "Vehicle.Color": "red" },
 *       attributeUpdateMode: "Merge",
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface BatchUpdateVehicle extends Binding.Service<
  BatchUpdateVehicle,
  "AWS.IoTFleetWise.BatchUpdateVehicle",
  () => Effect.Effect<
    (
      request: iotfleetwise.BatchUpdateVehicleRequest,
    ) => Effect.Effect<
      iotfleetwise.BatchUpdateVehicleResponse,
      iotfleetwise.BatchUpdateVehicleError
    >
  >
> {}
export const BatchUpdateVehicle = Binding.Service<BatchUpdateVehicle>(
  "AWS.IoTFleetWise.BatchUpdateVehicle",
);

export const BatchUpdateVehicleHttp = Layer.effect(
  BatchUpdateVehicle,
  makeFleetWiseAccountHttpBinding({
    tag: "AWS.IoTFleetWise.BatchUpdateVehicle",
    operation: iotfleetwise.batchUpdateVehicle,
    // The vehicle names are runtime arguments, so the grant is the
    // account-wide vehicle pattern.
    actions: ["iotfleetwise:BatchUpdateVehicle", "iotfleetwise:UpdateVehicle"],
    resources: ["arn:aws:iotfleetwise:*:*:vehicle/*"],
  }),
);
