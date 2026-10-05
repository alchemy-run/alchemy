import * as Layer from "effect/Layer";
import { AgentPool, AgentPoolProvider } from "./AgentPool.ts";
import {
  DeploymentSafeguard,
  DeploymentSafeguardProvider,
} from "./DeploymentSafeguard.ts";
import { Fleet, FleetProvider } from "./Fleet.ts";
import {
  FleetAutoUpgradeProfile,
  FleetAutoUpgradeProfileProvider,
} from "./FleetAutoUpgradeProfile.ts";
import {
  FleetManagedNamespace,
  FleetManagedNamespaceProvider,
} from "./FleetManagedNamespace.ts";
import { FleetMember, FleetMemberProvider } from "./FleetMember.ts";
import {
  FleetUpdateStrategy,
  FleetUpdateStrategyProvider,
} from "./FleetUpdateStrategy.ts";
import { IdentityBinding, IdentityBindingProvider } from "./IdentityBinding.ts";
import {
  MaintenanceConfiguration,
  MaintenanceConfigurationProvider,
} from "./MaintenanceConfiguration.ts";
import { ManagedCluster, ManagedClusterProvider } from "./ManagedCluster.ts";
import {
  ManagedNamespace,
  ManagedNamespaceProvider,
} from "./ManagedNamespace.ts";
import { Snapshot, SnapshotProvider } from "./Snapshot.ts";
import {
  TrustedAccessRoleBinding,
  TrustedAccessRoleBindingProvider,
} from "./TrustedAccessRoleBinding.ts";

export const resources = [
  AgentPool,
  DeploymentSafeguard,
  Fleet,
  FleetAutoUpgradeProfile,
  FleetManagedNamespace,
  FleetMember,
  FleetUpdateStrategy,
  IdentityBinding,
  MaintenanceConfiguration,
  ManagedCluster,
  ManagedNamespace,
  Snapshot,
  TrustedAccessRoleBinding,
];
export const layers = () =>
  Layer.mergeAll(
    AgentPoolProvider(),
    DeploymentSafeguardProvider(),
    FleetProvider(),
    FleetAutoUpgradeProfileProvider(),
    FleetManagedNamespaceProvider(),
    FleetMemberProvider(),
    FleetUpdateStrategyProvider(),
    IdentityBindingProvider(),
    MaintenanceConfigurationProvider(),
    ManagedClusterProvider(),
    ManagedNamespaceProvider(),
    SnapshotProvider(),
    TrustedAccessRoleBindingProvider(),
  );
