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
  lakeWorkspace,
  logLevel,
  withWorkspaceSlot,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const KEY_NAME = "cmk";

const protectorWhere = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return {
      subscriptionId,
      resourceGroupName,
      workspaceName,
      encryptionProtectorName: "current",
    };
  });

const getProtector = (resourceGroupName: string, workspaceName: string) =>
  Effect.flatMap(
    protectorWhere(resourceGroupName, workspaceName),
    synapse.GetWorkspaceManagedSqlServerEncryptionProtector,
  );

/** An activated customer-managed-key workspace. */
const cmkWorkspace = Effect.gen(function* () {
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
    // Synapse fails activation when `{vault}_{key}_{version}` exceeds ~128
    // characters, so the generated (long) key name cannot be used.
    name: "synapse-cmk",
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

/** A customer-managed-key workspace, which owns an encryption protector. */
const program = Effect.gen(function* () {
  const { group, workspace, workspaceKey } = yield* cmkWorkspace;
  const protector = yield* Azure.Synapse.EncryptionProtector("Protector", {
    resourceGroup: group.resourceGroupName,
    workspace: workspaceKey.workspaceName,
    serverKeyType: "AzureKeyVault",
  });
  return { group, workspace, protector };
});

// Azure exposes `encryptionProtector` only on customer-managed-key
// workspaces: on a service-managed workspace GET, LIST, and PUT all answer
// with an empty-bodied 404 on every API version (2019-06-01-preview through
// 2021-06-01). Free; the workspace takes ~3-5 min.
test.provider(
  "a service-managed workspace has no encryption protector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(lakeWorkspace());
      const where = yield* protectorWhere(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      const get = yield* synapse
        .GetWorkspaceManagedSqlServerEncryptionProtector(where)
        .pipe(Effect.flip);
      expect(get._tag).toEqual("NotFound");
      const put = yield* synapse
        .WorkspaceManagedSqlServerEncryptionProtectorCreateOrUpdate({
          ...where,
          properties: { serverKeyType: "ServiceManaged" },
        })
        .pipe(Effect.flip);
      expect(put._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);

// Azure also answers the protector endpoint with an empty 404 on an
// ACTIVATED customer-managed-key workspace (checked on every api-version
// from 2019-06-01-preview to 2021-06-01-preview, with and without a
// dedicated SQL pool, Oct 2026), so the converge lifecycle below cannot
// run. This probe pins that platform behaviour; when it starts failing,
// run the lifecycle with AZURE_TEST_SYNAPSE_ENCRYPTION_PROTECTOR=1.
// A customer-managed-key workspace needs a purge-protected Key Vault, which
// stays soft-deleted (unpurgeable) for 7 days after the test — a residue
// the account-wide cleanup cannot remove. Cost is cents (Key Vault
// operations); the workspace takes ~3-8 min.
test.provider.skipIf(!runExpensive)(
  "an activated customer-managed-key workspace exposes no encryption protector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, workspaceKey } =
        yield* stack.deploy(cmkWorkspace);
      expect(workspaceKey.isActiveCMK).toEqual(true);
      const get = yield* getProtector(
        group.resourceGroupName,
        workspace.workspaceName,
      ).pipe(Effect.flip);
      expect(get._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);

test.provider.skipIf(!process.env.AZURE_TEST_SYNAPSE_ENCRYPTION_PROTECTOR)(
  "converge a synapse workspace encryption protector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, protector } = yield* stack.deploy(program);
      expect(protector.serverKeyType).toEqual("AzureKeyVault");
      const observed = yield* getProtector(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties?.serverKeyType).toEqual("AzureKeyVault");
      expect(observed.properties?.serverKeyName).toBeDefined();

      // Re-deploying is a no-op that keeps the same protector.
      const again = yield* stack.deploy(program);
      expect(again.protector.protectorId).toEqual(protector.protectorId);

      yield* stack.destroy();
    }).pipe(withWorkspaceSlot, logLevel),
  {
    tags: ["provider:azure", "provider:azure:synapse", "live"],
    timeout: 900_000,
  },
);
