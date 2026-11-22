import * as Layer from "effect/Layer";
import { AccessPolicy, AccessPolicyProvider } from "./AccessPolicy.ts";
import { Key, KeyProvider } from "./Key.ts";
import { ManagedHsm, ManagedHsmProvider } from "./ManagedHsm.ts";
import { ManagedHsmKey, ManagedHsmKeyProvider } from "./ManagedHsmKey.ts";
import {
  ManagedHsmPrivateEndpointConnection,
  ManagedHsmPrivateEndpointConnectionProvider,
} from "./ManagedHsmPrivateEndpointConnection.ts";
import {
  ManagedHsmRoleAssignment,
  ManagedHsmRoleAssignmentProvider,
} from "./ManagedHsmRoleAssignment.ts";
import {
  ManagedHsmRoleDefinition,
  ManagedHsmRoleDefinitionProvider,
} from "./ManagedHsmRoleDefinition.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Vault, VaultProvider } from "./Vault.ts";
import {
  VaultPrivateEndpointConnection,
  VaultPrivateEndpointConnectionProvider,
} from "./VaultPrivateEndpointConnection.ts";

export const resources = [
  AccessPolicy,
  Key,
  ManagedHsm,
  ManagedHsmKey,
  ManagedHsmPrivateEndpointConnection,
  ManagedHsmRoleAssignment,
  ManagedHsmRoleDefinition,
  Secret,
  Vault,
  VaultPrivateEndpointConnection,
];
export const layers = () =>
  Layer.mergeAll(
    AccessPolicyProvider(),
    KeyProvider(),
    ManagedHsmProvider(),
    ManagedHsmKeyProvider(),
    ManagedHsmPrivateEndpointConnectionProvider(),
    ManagedHsmRoleAssignmentProvider(),
    ManagedHsmRoleDefinitionProvider(),
    SecretProvider(),
    VaultProvider(),
    VaultPrivateEndpointConnectionProvider(),
  );
