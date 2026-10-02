import * as Layer from "effect/Layer";
import { AvailabilitySet, AvailabilitySetProvider } from "./AvailabilitySet.ts";
import {
  CapacityReservation,
  CapacityReservationProvider,
} from "./CapacityReservation.ts";
import {
  CapacityReservationGroup,
  CapacityReservationGroupProvider,
} from "./CapacityReservationGroup.ts";
import { DedicatedHost, DedicatedHostProvider } from "./DedicatedHost.ts";
import {
  DedicatedHostGroup,
  DedicatedHostGroupProvider,
} from "./DedicatedHostGroup.ts";
import { Image, ImageProvider } from "./Image.ts";
import {
  InterconnectBlock,
  InterconnectBlockProvider,
} from "./InterconnectBlock.ts";
import {
  ProximityPlacementGroup,
  ProximityPlacementGroupProvider,
} from "./ProximityPlacementGroup.ts";
import { RestorePoint, RestorePointProvider } from "./RestorePoint.ts";
import {
  RestorePointCollection,
  RestorePointCollectionProvider,
} from "./RestorePointCollection.ts";
import { SshPublicKey, SshPublicKeyProvider } from "./SshPublicKey.ts";
import { VirtualMachine, VirtualMachineProvider } from "./VirtualMachine.ts";
import {
  VirtualMachineDiagnosticRunCommand,
  VirtualMachineDiagnosticRunCommandProvider,
} from "./VirtualMachineDiagnosticRunCommand.ts";
import {
  VirtualMachineExtension,
  VirtualMachineExtensionProvider,
} from "./VirtualMachineExtension.ts";
import {
  VirtualMachineRunCommand,
  VirtualMachineRunCommandProvider,
} from "./VirtualMachineRunCommand.ts";
import {
  VirtualMachineScaleSet,
  VirtualMachineScaleSetProvider,
} from "./VirtualMachineScaleSet.ts";
import {
  VirtualMachineScaleSetExtension,
  VirtualMachineScaleSetExtensionProvider,
} from "./VirtualMachineScaleSetExtension.ts";

export const resources = [
  AvailabilitySet,
  CapacityReservation,
  CapacityReservationGroup,
  DedicatedHost,
  DedicatedHostGroup,
  Image,
  InterconnectBlock,
  ProximityPlacementGroup,
  RestorePoint,
  RestorePointCollection,
  SshPublicKey,
  VirtualMachine,
  VirtualMachineDiagnosticRunCommand,
  VirtualMachineExtension,
  VirtualMachineRunCommand,
  VirtualMachineScaleSet,
  VirtualMachineScaleSetExtension,
];
export const layers = () =>
  Layer.mergeAll(
    AvailabilitySetProvider(),
    CapacityReservationProvider(),
    CapacityReservationGroupProvider(),
    DedicatedHostProvider(),
    DedicatedHostGroupProvider(),
    ImageProvider(),
    InterconnectBlockProvider(),
    ProximityPlacementGroupProvider(),
    RestorePointProvider(),
    RestorePointCollectionProvider(),
    SshPublicKeyProvider(),
    VirtualMachineProvider(),
    VirtualMachineDiagnosticRunCommandProvider(),
    VirtualMachineExtensionProvider(),
    VirtualMachineRunCommandProvider(),
    VirtualMachineScaleSetProvider(),
    VirtualMachineScaleSetExtensionProvider(),
  );
