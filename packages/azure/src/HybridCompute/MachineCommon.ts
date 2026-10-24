import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";

/**
 * Location of an Arc machine; machine sub-resources must live in the same
 * location as their machine.
 */
export const machineLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  machineName: string,
) =>
  hybridcompute
    .GetMachine({ subscriptionId, resourceGroupName, machineName })
    .pipe(Effect.map((machine) => machine.location));
