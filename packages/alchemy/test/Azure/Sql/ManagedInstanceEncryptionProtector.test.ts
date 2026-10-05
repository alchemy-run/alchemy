import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { managedInstance } from "./managed.ts";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Built-in role `Key Vault Crypto Service Encryption User`. */
const CRYPTO_SERVICE_ENCRYPTION_USER = "e147488a-f6f5-4113-8e2d-b22465e65bf6";

/**
 * Give the instance a system-assigned identity out of band (the
 * ManagedInstance resource does not model identities yet) and return its
 * principal ID.
 */
const instanceIdentity = (
  resourceGroupName: string,
  managedInstanceName: string,
) =>
  Effect.gen(function* () {
    const where = {
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
    };
    yield* sql.UpdateManagedInstance({
      ...where,
      identity: { type: "SystemAssigned" },
    });
    const instance = yield* awaitObserved(
      sql.GetManagedInstance(where),
      (mi) => mi.identity?.principalId !== undefined,
      60,
    );
    return instance.identity?.principalId ?? "";
  });

const program = (
  password: Redacted.Redacted<string>,
  props: { principalId?: string; key?: "KeyA" | "KeyB"; protector?: boolean },
) =>
  Effect.gen(function* () {
    const mi = yield* managedInstance(password);
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: mi.group.resourceGroupName,
      location: mi.group.location,
      enableRbacAuthorization: true,
      enablePurgeProtection: true,
      softDeleteRetentionInDays: 7,
    });
    const keys = yield* Effect.forEach(["KeyA", "KeyB"] as const, (name) =>
      Azure.KeyVault.Key(name, {
        resourceGroup: mi.group.resourceGroupName,
        vault: vault.vaultName,
        name: `tde${name.toLowerCase()}`,
        kty: "RSA",
        keySize: 2048,
      }),
    );
    if (props.principalId === undefined || props.key === undefined) {
      return { ...mi, vault, key: undefined, protector: undefined };
    }
    yield* Azure.Authorization.RoleAssignment("VaultAccess", {
      scope: vault.vaultId,
      roleDefinitionId: CRYPTO_SERVICE_ENCRYPTION_USER,
      principalId: props.principalId,
      principalType: "ServicePrincipal",
    });
    const key = yield* Azure.Sql.ManagedInstanceKey("TdeKey", {
      resourceGroup: mi.group.resourceGroupName,
      managedInstance: mi.instance.managedInstanceName,
      uri: keys[props.key === "KeyA" ? 0 : 1]!.keyUriWithVersion,
    });
    const protector = props.protector
      ? yield* Azure.Sql.ManagedInstanceEncryptionProtector("Protector", {
          resourceGroup: mi.group.resourceGroupName,
          managedInstance: mi.instance.managedInstanceName,
          serverKeyType: "AzureKeyVault",
          serverKeyName: key.keyName,
        })
      : undefined;
    return { ...mi, vault, key, protector };
  });

const getProtector = (resourceGroupName: string, managedInstanceName: string) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedInstanceEncryptionProtector({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      encryptionProtectorName: "current",
    });
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "switch a managed instance to a customer-managed tde key and back",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;
      const base = yield* stack.deploy(program(password, {}));
      const principalId = yield* instanceIdentity(
        base.group.resourceGroupName,
        base.instance.managedInstanceName,
      );
      const get = getProtector(
        base.group.resourceGroupName,
        base.instance.managedInstanceName,
      );

      const first = yield* stack.deploy(
        program(password, { principalId, key: "KeyA", protector: true }),
      );
      expect((yield* get).properties?.serverKeyName).toEqual(
        first.key!.keyName,
      );

      // In place: rotate to the other key.
      const second = yield* stack.deploy(
        program(password, { principalId, key: "KeyB", protector: true }),
      );
      expect(
        (yield* awaitObserved(
          get,
          (p) => p.properties?.serverKeyName === second.key!.keyName,
          12,
        )).properties?.serverKeyName,
      ).toEqual(second.key!.keyName);

      // Removing the protector switches back to the service-managed key.
      yield* stack.deploy(program(password, { principalId, key: "KeyB" }));
      expect(
        (yield* awaitObserved(
          get,
          (p) => p.properties?.serverKeyType === "ServiceManaged",
          12,
        )).properties?.serverKeyType,
      ).toEqual("ServiceManaged");

      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
