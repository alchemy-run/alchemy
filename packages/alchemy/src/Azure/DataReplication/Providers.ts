import * as Layer from "effect/Layer";
import { AlertSetting, AlertSettingProvider } from "./AlertSetting.ts";
import { Fabric, FabricProvider } from "./Fabric.ts";
import { FabricAgent, FabricAgentProvider } from "./FabricAgent.ts";
import { Policy, PolicyProvider } from "./Policy.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { ProtectedItem, ProtectedItemProvider } from "./ProtectedItem.ts";
import {
  ReplicationExtension,
  ReplicationExtensionProvider,
} from "./ReplicationExtension.ts";
import { Vault, VaultProvider } from "./Vault.ts";

export const resources = [
  AlertSetting,
  Fabric,
  FabricAgent,
  Policy,
  PrivateEndpointConnection,
  ProtectedItem,
  ReplicationExtension,
  Vault,
];
export const layers = () =>
  Layer.mergeAll(
    AlertSettingProvider(),
    FabricProvider(),
    FabricAgentProvider(),
    PolicyProvider(),
    PrivateEndpointConnectionProvider(),
    ProtectedItemProvider(),
    ReplicationExtensionProvider(),
    VaultProvider(),
  );
