import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { managedDatabase } from "./managed.ts";
import {
  awaitGone,
  logLevel,
  newPassword,
  SQL_TAGS,
  subscription,
  awaitObserved,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getUpload = (
  resourceGroupName: string,
  managedInstanceName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetManagedLedgerDigestUpload({
      subscriptionId: yield* subscription,
      resourceGroupName,
      managedInstanceName,
      databaseName,
      ledgerDigestUploads: "current",
    });
  });

const program = (password: Redacted.Redacted<string>, upload: boolean) =>
  Effect.gen(function* () {
    const mi = yield* managedDatabase(password, {
      identity: { type: "SystemAssigned" },
    });
    const account = yield* Azure.Storage.StorageAccount("Digests", {
      resourceGroup: mi.group.resourceGroupName,
      location: mi.group.location,
    });
    // The instance writes digests with its managed identity.
    yield* Azure.Authorization.RoleAssignment("DigestWriter", {
      scope: account.storageAccountId,
      roleDefinitionId:
        Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
      principalId: mi.instance.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    const digests = upload
      ? yield* Azure.Sql.ManagedLedgerDigestUpload("DigestUpload", {
          resourceGroup: mi.group.resourceGroupName,
          managedInstance: mi.instance.managedInstanceName,
          database: mi.database.databaseName,
          digestStorageEndpoint: account.primaryEndpoints.blob.as<string>(),
        })
      : undefined;
    return { ...mi, account, digests };
  });

// Needs a SQL Managed Instance (~$0.70/hour; the first instance in a subnet
// takes 30 minutes to 6 hours): several dollars per run, so this only runs
// with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "enable and disable managed ledger digest uploads",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;
      const first = yield* stack.deploy(program(password, true));
      const get = getUpload(
        first.group.resourceGroupName,
        first.instance.managedInstanceName,
        first.database.databaseName,
      );
      expect((yield* get).properties?.state).toEqual("Enabled");
      yield* stack.deploy(program(password, false));
      expect(
        (yield* awaitObserved(
          get,
          (u) => u.properties?.state === "Disabled",
          12,
        )).properties?.state,
      ).toEqual("Disabled");
      yield* stack.destroy();
      expect(yield* awaitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags: SQL_TAGS, timeout: 4 * 3_600_000 },
);
