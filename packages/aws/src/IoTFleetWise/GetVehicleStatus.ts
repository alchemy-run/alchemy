import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import type { Vehicle } from "./Vehicle.ts";

/**
 * `GetVehicleStatus` request with `vehicleName` injected from the bound
 * vehicle.
 */
export interface GetVehicleStatusRequest extends Omit<
  iotfleetwise.GetVehicleStatusRequest,
  "vehicleName"
> {}

/**
 * Runtime binding for the `GetVehicleStatus` operation (IAM action
 * `iotfleetwise:GetVehicleStatus`), scoped to one {@link Vehicle}.
 *
 * Reads the deployment status of the campaigns, decoder manifests, and
 * state templates associated with the bound vehicle. Provide the
 * implementation with
 * `Effect.provide(AWS.IoTFleetWise.GetVehicleStatusHttp)`.
 *
 * ### Vehicle Status
 * **Example:** Check Campaign Deployment on a Vehicle
 * ```typescript
 * const getVehicleStatus = yield* IoTFleetWise.GetVehicleStatus(vehicle);
 *
 * const status = yield* getVehicleStatus();
 * for (const campaign of status.campaigns ?? []) {
 *   console.log(campaign.campaignName, campaign.status);
 * }
 * ```
 *
 * @binding
 */
export interface GetVehicleStatus extends Binding.Service<
  GetVehicleStatus,
  "AWS.IoTFleetWise.GetVehicleStatus",
  (
    vehicle: Vehicle,
  ) => Effect.Effect<
    (
      request?: GetVehicleStatusRequest,
    ) => Effect.Effect<iotfleetwise.GetVehicleStatusResponse, iotfleetwise.GetVehicleStatusError>
  >
> {}
export const GetVehicleStatus = Binding.Service<GetVehicleStatus>(
  "AWS.IoTFleetWise.GetVehicleStatus",
);

export const GetVehicleStatusHttp = Layer.effect(
  GetVehicleStatus,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.GetVehicleStatus",
    operation: iotfleetwise.getVehicleStatus,
    actions: ["iotfleetwise:GetVehicleStatus"],
    requestKey: "vehicleName",
    identifier: (vehicle: Vehicle) => vehicle.vehicleName,
    // GetVehicleStatus authorizes on both the vehicle and its associated
    // campaigns — the campaign ARNs are unknowable at deploy time.
    resources: (vehicle: Vehicle) => [vehicle.vehicleArn, "arn:aws:iotfleetwise:*:*:campaign/*"],
  }),
);
