import * as Layer from "effect/Layer";
import { ArcSetting, ArcSettingProvider } from "./ArcSetting.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import {
  DeploymentSetting,
  DeploymentSettingProvider,
} from "./DeploymentSetting.ts";
import { EdgeDevice, EdgeDeviceProvider } from "./EdgeDevice.ts";
import { EdgeMachine, EdgeMachineProvider } from "./EdgeMachine.ts";
import {
  EdgeMachineDeploymentSetting,
  EdgeMachineDeploymentSettingProvider,
} from "./EdgeMachineDeploymentSetting.ts";
import { EdgeMachineDisk, EdgeMachineDiskProvider } from "./EdgeMachineDisk.ts";
import {
  EdgeMachineSecuritySetting,
  EdgeMachineSecuritySettingProvider,
} from "./EdgeMachineSecuritySetting.ts";
import {
  EdgeMachineVolume,
  EdgeMachineVolumeProvider,
} from "./EdgeMachineVolume.ts";
import { Extension, ExtensionProvider } from "./Extension.ts";
import { GalleryImage, GalleryImageProvider } from "./GalleryImage.ts";
import { GuestAgent, GuestAgentProvider } from "./GuestAgent.ts";
import { LogicalNetwork, LogicalNetworkProvider } from "./LogicalNetwork.ts";
import {
  MarketplaceGalleryImage,
  MarketplaceGalleryImageProvider,
} from "./MarketplaceGalleryImage.ts";
import {
  NetworkInterface,
  NetworkInterfaceProvider,
} from "./NetworkInterface.ts";
import { SecuritySetting, SecuritySettingProvider } from "./SecuritySetting.ts";
import {
  StorageContainer,
  StorageContainerProvider,
} from "./StorageContainer.ts";
import { VirtualHardDisk, VirtualHardDiskProvider } from "./VirtualHardDisk.ts";
import {
  VirtualMachineInstance,
  VirtualMachineInstanceProvider,
} from "./VirtualMachineInstance.ts";

export const resources = [
  ArcSetting,
  Cluster,
  DeploymentSetting,
  EdgeDevice,
  EdgeMachine,
  EdgeMachineDeploymentSetting,
  EdgeMachineDisk,
  EdgeMachineSecuritySetting,
  EdgeMachineVolume,
  Extension,
  GalleryImage,
  GuestAgent,
  LogicalNetwork,
  MarketplaceGalleryImage,
  NetworkInterface,
  SecuritySetting,
  StorageContainer,
  VirtualHardDisk,
  VirtualMachineInstance,
];
export const layers = () =>
  Layer.mergeAll(
    ArcSettingProvider(),
    ClusterProvider(),
    DeploymentSettingProvider(),
    EdgeDeviceProvider(),
    EdgeMachineProvider(),
    EdgeMachineDeploymentSettingProvider(),
    EdgeMachineDiskProvider(),
    EdgeMachineSecuritySettingProvider(),
    EdgeMachineVolumeProvider(),
    ExtensionProvider(),
    GalleryImageProvider(),
    GuestAgentProvider(),
    LogicalNetworkProvider(),
    MarketplaceGalleryImageProvider(),
    NetworkInterfaceProvider(),
    SecuritySettingProvider(),
    StorageContainerProvider(),
    VirtualHardDiskProvider(),
    VirtualMachineInstanceProvider(),
  );
