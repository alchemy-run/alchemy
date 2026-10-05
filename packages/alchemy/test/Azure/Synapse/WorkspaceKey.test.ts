import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as synapse from "@distilled.cloud/azure/synapse";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  LOCATION,
  PASSWORD,
  logLevel,
  untilGone,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const KEY_NAME = "cmk";

const getKey = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* synapse.GetKey({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      keyName: KEY_NAME,
    });
  });

const program = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: LOCATION,
  });
  const lake = yield* Azure.Storage.StorageAccount("Lake", {
    resourceGroup: group.resourceGroupName,
    location: LOCATION,
    isHnsEnabled: true,
  });
  const fs = yield* Azure.Storage.BlobContainer("Fs", {
    resourceGroup: group.resourceGroupName,
    storageAccount: lake.storageAccountName,
  });
  // Synapse requires soft delete + purge protection on the key's vault.
  const vault = yield* Azure.KeyVault.Vault("Keys", {
    resourceGroup: group.resourceGroupName,
    location: LOCATION,
    enablePurgeProtection: true,
    softDeleteRetentionInDays: 7,
    // The workspace identity is granted the key through an access policy;
    // RBAC-authorized vaults ignore access policies.
    enableRbacAuthorization: false,
  });
  const key = yield* Azure.KeyVault.Key("Cmk", {
    resourceGroup: group.resourceGroupName,
    vault: vault.vaultName,
    kty: "RSA",
    keySize: 3072,
  });
  const workspace = yield* Azure.Synapse.Workspace("Ws", {
    resourceGroup: group.resourceGroupName,
    location: LOCATION,
    defaultDataLakeStorage: {
      accountUrl: lake.primaryEndpoints.dfs.as<string>(),
      filesystem: fs.containerName,
    },
    sqlAdministratorLogin: "sqladminuser",
    sqlAdministratorLoginPassword: PASSWORD,
    customerManagedKey: { keyName: KEY_NAME, keyVaultUrl: key.keyUri },
  });
  const access = yield* Azure.KeyVault.AccessPolicy("WsAccess", {
    resourceGroup: group.resourceGroupName,
    vault: vault.vaultName,
    objectId: workspace.principalId.as<string>(),
    permissions: { keys: ["get", "wrapKey", "unwrapKey"] },
  });
  const workspaceKey = yield* Azure.Synapse.WorkspaceKey("Key", {
    resourceGroup: group.resourceGroupName,
    // Activate only after the workspace identity can use the key.
    workspace: Output.map(
      Output.all(workspace.workspaceName, access.objectId),
      ([name]) => name,
    ),
    name: KEY_NAME,
    keyVaultUrl: key.keyUri,
    isActiveCMK: true,
  });
  return { group, workspace, workspaceKey };
});

// A customer-managed-key workspace needs a purge-protected Key Vault, which
// stays soft-deleted (unpurgeable) for 7 days after the test — a residue
// the account-wide cleanup cannot remove. Cost is cents (Key Vault
// operations); the workspace takes ~3-8 min.
test.provider.skipIf(!runExpensive)(
  "activate and delete a synapse workspace customer-managed key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, workspaceKey } = yield* stack.deploy(program);
      expect(workspaceKey.isActiveCMK).toEqual(true);
      const observed = yield* getKey(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties?.isActiveCMK).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getKey(group.resourceGroupName, workspace.workspaceName),
        ),
      ).toEqual("gone");
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
