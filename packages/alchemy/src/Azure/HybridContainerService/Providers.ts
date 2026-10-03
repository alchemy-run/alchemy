import * as Layer from "effect/Layer";
import { AgentPool, AgentPoolProvider } from "./AgentPool.ts";
import {
  ProvisionedCluster,
  ProvisionedClusterProvider,
} from "./ProvisionedCluster.ts";
import { VirtualNetwork, VirtualNetworkProvider } from "./VirtualNetwork.ts";

export const resources = [AgentPool, ProvisionedCluster, VirtualNetwork];
export const layers = () =>
  Layer.mergeAll(
    AgentPoolProvider(),
    ProvisionedClusterProvider(),
    VirtualNetworkProvider(),
  );
