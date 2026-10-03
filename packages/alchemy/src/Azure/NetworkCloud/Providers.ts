import * as Layer from "effect/Layer";
import { AccessBridge, AccessBridgeProvider } from "./AccessBridge.ts";
import { AgentPool, AgentPoolProvider } from "./AgentPool.ts";
import {
  BareMetalMachineKeySet,
  BareMetalMachineKeySetProvider,
} from "./BareMetalMachineKeySet.ts";
import { BmcKeySet, BmcKeySetProvider } from "./BmcKeySet.ts";
import {
  CloudServicesNetwork,
  CloudServicesNetworkProvider,
} from "./CloudServicesNetwork.ts";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { ClusterManager, ClusterManagerProvider } from "./ClusterManager.ts";
import {
  KubernetesCluster,
  KubernetesClusterProvider,
} from "./KubernetesCluster.ts";
import {
  KubernetesClusterFeature,
  KubernetesClusterFeatureProvider,
} from "./KubernetesClusterFeature.ts";
import { L2Network, L2NetworkProvider } from "./L2Network.ts";
import { L3Network, L3NetworkProvider } from "./L3Network.ts";
import {
  MetricsConfiguration,
  MetricsConfigurationProvider,
} from "./MetricsConfiguration.ts";
import { TrunkedNetwork, TrunkedNetworkProvider } from "./TrunkedNetwork.ts";
import { VirtualMachine, VirtualMachineProvider } from "./VirtualMachine.ts";
import { Volume, VolumeProvider } from "./Volume.ts";

export const resources = [
  AccessBridge,
  AgentPool,
  BareMetalMachineKeySet,
  BmcKeySet,
  CloudServicesNetwork,
  Cluster,
  ClusterManager,
  KubernetesCluster,
  KubernetesClusterFeature,
  L2Network,
  L3Network,
  MetricsConfiguration,
  TrunkedNetwork,
  VirtualMachine,
  Volume,
];

export const layers = () =>
  Layer.mergeAll(
    AccessBridgeProvider(),
    AgentPoolProvider(),
    BareMetalMachineKeySetProvider(),
    BmcKeySetProvider(),
    CloudServicesNetworkProvider(),
    ClusterProvider(),
    ClusterManagerProvider(),
    KubernetesClusterProvider(),
    KubernetesClusterFeatureProvider(),
    L2NetworkProvider(),
    L3NetworkProvider(),
    MetricsConfigurationProvider(),
    TrunkedNetworkProvider(),
    VirtualMachineProvider(),
    VolumeProvider(),
  );
