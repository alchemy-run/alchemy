import * as Layer from "effect/Layer";
import {
  HybridMachineAssignment,
  HybridMachineAssignmentProvider,
} from "./HybridMachineAssignment.ts";
import {
  VirtualMachineAssignment,
  VirtualMachineAssignmentProvider,
} from "./VirtualMachineAssignment.ts";
import {
  VirtualMachineScaleSetAssignment,
  VirtualMachineScaleSetAssignmentProvider,
} from "./VirtualMachineScaleSetAssignment.ts";

export const resources = [
  HybridMachineAssignment,
  VirtualMachineAssignment,
  VirtualMachineScaleSetAssignment,
];
export const layers = () =>
  Layer.mergeAll(
    HybridMachineAssignmentProvider(),
    VirtualMachineAssignmentProvider(),
    VirtualMachineScaleSetAssignmentProvider(),
  );
