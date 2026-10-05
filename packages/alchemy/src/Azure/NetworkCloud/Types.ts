import type * as nc from "@distilled.cloud/azure/networkcloud";

/** Managed identity of a Nexus cluster manager, cluster, or virtual machine. */
export interface NexusIdentity {
  /** Identity type, e.g. `SystemAssigned` or `UserAssigned`. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of user-assigned managed identities to attach. */
  userAssignedIdentityIds?: string[];
}

/** A user granted access through a BMC or bare metal machine key set. */
export type NexusKeySetUser = nc.KeySetUser;

/** An SSH public key, e.g. `{ keyData: "ssh-ed25519 AAAA..." }`. */
export type NexusSshPublicKey = nc.SshPublicKey;

/** Name and location of the managed resource group a Nexus resource owns. */
export type NexusManagedResourceGroupConfiguration =
  nc.ManagedResourceGroupConfiguration;

/** Admin user name and SSH keys for Kubernetes nodes. */
export type NexusAdministratorConfiguration = nc.AdministratorConfiguration;

/** A key/value pair, e.g. a Kubernetes cluster feature option. */
export type NexusKeyValuePair = nc.StringKeyValuePair;
