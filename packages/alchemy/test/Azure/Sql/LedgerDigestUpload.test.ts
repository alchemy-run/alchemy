import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sql from "@distilled.cloud/azure/sql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  awaitGone,
  awaitObserved,
  logLevel,
  newPassword,
  SQL_TAGS,
  sqlDatabase,
  subscription,
} from "./harness.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getUpload = (
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  Effect.gen(function* () {
    return yield* sql.GetLedgerDigestUpload({
      subscriptionId: yield* subscription,
      resourceGroupName,
      serverName,
      databaseName,
      ledgerDigestUploads: "current",
    });
  });

const program = (password: Redacted.Redacted<string>, upload: boolean) =>
  Effect.gen(function* () {
    const { group, server, database } = yield* sqlDatabase(
      password,
      {},
      { identity: { type: "SystemAssigned" } },
    );
    const account = yield* Azure.Storage.StorageAccount("Digests", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
    });
    // The server writes digests with its managed identity.
    yield* Azure.Authorization.RoleAssignment("DigestWriter", {
      scope: account.storageAccountId,
      roleDefinitionId:
        Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
      principalId: server.principalId.as<string>(),
      principalType: "ServicePrincipal",
    });
    const digests = upload
      ? yield* Azure.Sql.LedgerDigestUpload("DigestUpload", {
          resourceGroup: group.resourceGroupName,
          server: server.serverName,
          database: database.databaseName,
          digestStorageEndpoint: account.primaryEndpoints.blob.as<string>(),
        })
      : undefined;
    return { group, server, database, account, digests };
  });

// Basic database (~$0.007/hour) and a storage account: < $0.01 per run.
test.provider(
  "enable and disable ledger digest uploads",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const password = yield* newPassword;

      const { group, server, database, digests } = yield* stack.deploy(
        program(password, true),
      );
      expect(digests?.state).toEqual("Enabled");
      const get = getUpload(
        group.resourceGroupName,
        server.serverName,
        database.databaseName,
      );
      const observed = yield* get;
      expect(observed.properties?.state).toEqual("Enabled");
      expect(observed.properties?.digestStorageEndpoint).toContain(
        ".blob.core.windows.net",
      );

      // Re-deploying converges without a write.
      const again = yield* stack.deploy(program(password, true));
      expect(again.digests?.settingId).toEqual(digests?.settingId);

      // Removing the resource disables uploads.
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
  { tags: SQL_TAGS, timeout: 900_000 },
);
