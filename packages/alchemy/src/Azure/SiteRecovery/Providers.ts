import * as Layer from "effect/Layer";
import { AlertSetting, AlertSettingProvider } from "./AlertSetting.ts";
import { Fabric, FabricProvider } from "./Fabric.ts";
import { NetworkMapping, NetworkMappingProvider } from "./NetworkMapping.ts";
import { ProtectedItem, ProtectedItemProvider } from "./ProtectedItem.ts";
import {
  ProtectionCluster,
  ProtectionClusterProvider,
} from "./ProtectionCluster.ts";
import {
  ProtectionContainer,
  ProtectionContainerProvider,
} from "./ProtectionContainer.ts";
import {
  ProtectionContainerMapping,
  ProtectionContainerMappingProvider,
} from "./ProtectionContainerMapping.ts";
import { RecoveryPlan, RecoveryPlanProvider } from "./RecoveryPlan.ts";
import {
  ReplicationPolicy,
  ReplicationPolicyProvider,
} from "./ReplicationPolicy.ts";
import {
  StorageClassificationMapping,
  StorageClassificationMappingProvider,
} from "./StorageClassificationMapping.ts";

export const resources = [
  AlertSetting,
  Fabric,
  NetworkMapping,
  ProtectedItem,
  ProtectionCluster,
  ProtectionContainer,
  ProtectionContainerMapping,
  RecoveryPlan,
  ReplicationPolicy,
  StorageClassificationMapping,
];
export const layers = () =>
  Layer.mergeAll(
    AlertSettingProvider(),
    FabricProvider(),
    NetworkMappingProvider(),
    ProtectedItemProvider(),
    ProtectionClusterProvider(),
    ProtectionContainerProvider(),
    ProtectionContainerMappingProvider(),
    RecoveryPlanProvider(),
    ReplicationPolicyProvider(),
    StorageClassificationMappingProvider(),
  );
