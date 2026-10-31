import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { makeFleetWiseResourceHttpBinding } from "./BindingHttp.ts";
import { DisassociateVehicleFleet } from "./DisassociateVehicleFleet.ts";
import type { Fleet } from "./Fleet.ts";

export const DisassociateVehicleFleetHttp = Layer.effect(
  DisassociateVehicleFleet,
  makeFleetWiseResourceHttpBinding({
    tag: "AWS.IoTFleetWise.DisassociateVehicleFleet",
    operation: iotfleetwise.disassociateVehicleFleet,
    actions: ["iotfleetwise:DisassociateVehicleFleet"],
    requestKey: "fleetId",
    identifier: (fleet: Fleet) => fleet.fleetId,
    resources: (fleet: Fleet) => [
      fleet.fleetArn,
      AWSBindings.partitionArn("iotfleetwise:*:*:vehicle/*"),
    ],
  }),
);
