import * as Layer from "effect/Layer";
import {
  AvailabilityGroupListener,
  AvailabilityGroupListenerProvider,
} from "./AvailabilityGroupListener.ts";
import {
  SqlVirtualMachine,
  SqlVirtualMachineProvider,
} from "./SqlVirtualMachine.ts";
import {
  SqlVirtualMachineGroup,
  SqlVirtualMachineGroupProvider,
} from "./SqlVirtualMachineGroup.ts";

export const resources = [
  AvailabilityGroupListener,
  SqlVirtualMachine,
  SqlVirtualMachineGroup,
];
export const layers = () =>
  Layer.mergeAll(
    AvailabilityGroupListenerProvider(),
    SqlVirtualMachineProvider(),
    SqlVirtualMachineGroupProvider(),
  );
