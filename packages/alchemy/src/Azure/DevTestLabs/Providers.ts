import * as Layer from "effect/Layer";
import { ArtifactSource, ArtifactSourceProvider } from "./ArtifactSource.ts";
import { CustomImage, CustomImageProvider } from "./CustomImage.ts";
import { Disk, DiskProvider } from "./Disk.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { Formula, FormulaProvider } from "./Formula.ts";
import { Lab, LabProvider } from "./Lab.ts";
import { LabSchedule, LabScheduleProvider } from "./LabSchedule.ts";
import {
  LabVirtualNetwork,
  LabVirtualNetworkProvider,
} from "./LabVirtualNetwork.ts";
import {
  NotificationChannel,
  NotificationChannelProvider,
} from "./NotificationChannel.ts";
import { Policy, PolicyProvider } from "./Policy.ts";
import { Schedule, ScheduleProvider } from "./Schedule.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { ServiceFabric, ServiceFabricProvider } from "./ServiceFabric.ts";
import {
  ServiceFabricSchedule,
  ServiceFabricScheduleProvider,
} from "./ServiceFabricSchedule.ts";
import { ServiceRunner, ServiceRunnerProvider } from "./ServiceRunner.ts";
import { User, UserProvider } from "./User.ts";
import { VirtualMachine, VirtualMachineProvider } from "./VirtualMachine.ts";
import {
  VirtualMachineSchedule,
  VirtualMachineScheduleProvider,
} from "./VirtualMachineSchedule.ts";

export const resources = [
  ArtifactSource,
  CustomImage,
  Disk,
  Environment,
  Formula,
  Lab,
  LabSchedule,
  LabVirtualNetwork,
  NotificationChannel,
  Policy,
  Schedule,
  Secret,
  ServiceFabric,
  ServiceFabricSchedule,
  ServiceRunner,
  User,
  VirtualMachine,
  VirtualMachineSchedule,
];
export const layers = () =>
  Layer.mergeAll(
    ArtifactSourceProvider(),
    CustomImageProvider(),
    DiskProvider(),
    EnvironmentProvider(),
    FormulaProvider(),
    LabProvider(),
    LabScheduleProvider(),
    LabVirtualNetworkProvider(),
    NotificationChannelProvider(),
    PolicyProvider(),
    ScheduleProvider(),
    SecretProvider(),
    ServiceFabricProvider(),
    ServiceFabricScheduleProvider(),
    ServiceRunnerProvider(),
    UserProvider(),
    VirtualMachineProvider(),
    VirtualMachineScheduleProvider(),
  );
