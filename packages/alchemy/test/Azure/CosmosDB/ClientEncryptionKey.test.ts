import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  COSMOS_LOCATION,
  logLevel,
  subscriptionId,
  waitGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getKey = (
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  clientEncryptionKeyName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetSqlResourceClientEncryptionKey({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      clientEncryptionKeyName,
    }),
  );

// The control plane stores the wrapped key opaquely; it is only unwrapped
// by client SDKs, so fixed bytes and a placeholder key URL suffice here.
const WRAPPED_V1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
const WRAPPED_V2 = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC";
const KEK_V1 = "https://alchemy-test.vault.azure.net/keys/cmk/1";
const KEK_V2 = "https://alchemy-test.vault.azure.net/keys/cmk/2";

const program = (props: { wrapped: string; kek: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
    });
    const database = yield* Azure.CosmosDB.SqlDatabase("Database", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const key = yield* Azure.CosmosDB.ClientEncryptionKey("Cek", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      database: database.databaseName,
      wrappedDataEncryptionKey: props.wrapped,
      keyWrapMetadata: { name: "cmk", value: props.kek },
    });
    return { group, account, database, key };
  });

// Serverless account: no cost while idle; the account dominates the
// runtime (~2-15 min create + delete).
test.provider(
  "create, rewrap, and delete a Cosmos DB client encryption key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, database, key } = yield* stack.deploy(
        program({ wrapped: WRAPPED_V1, kek: KEK_V1 }),
      );
      const where = [
        group.resourceGroupName,
        account.accountName,
        database.databaseName,
      ] as const;
      expect(key.encryptionAlgorithm).toEqual("AEAD_AES_256_CBC_HMAC_SHA256");
      const observed = yield* getKey(...where, key.clientEncryptionKeyName);
      expect(observed.properties?.resource?.wrappedDataEncryptionKey).toEqual(
        WRAPPED_V1,
      );
      expect(observed.properties?.resource?.keyWrapMetadata?.value).toEqual(
        KEK_V1,
      );

      // In-place update: rewrap under a new key encryption key.
      const updated = yield* stack.deploy(
        program({ wrapped: WRAPPED_V2, kek: KEK_V2 }),
      );
      expect(updated.key.clientEncryptionKeyId).toEqual(
        key.clientEncryptionKeyId,
      );
      expect(updated.key.keyWrapMetadataValue).toEqual(KEK_V2);
      const reobserved = yield* getKey(...where, key.clientEncryptionKeyName);
      expect(reobserved.properties?.resource?.wrappedDataEncryptionKey).toEqual(
        WRAPPED_V2,
      );

      // Keys have no delete API; they go away with their database.
      yield* stack.destroy();
      expect(
        yield* waitGone(getKey(...where, key.clientEncryptionKeyName), 60),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
