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

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetDatabaseAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const program = (props: {
  tags: Record<string, string>;
  consistency: Azure.CosmosDB.ConsistencyLevel;
  ipRules: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
      capabilities: ["EnableServerless"],
      consistencyPolicy: { defaultConsistencyLevel: props.consistency },
      ipRules: props.ipRules,
      tags: props.tags,
    });
    return { group, account };
  });

// Serverless account: no cost while idle; create + delete takes ~5-15 min.
test.provider(
  "create, update, and delete a serverless Cosmos DB account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({
          tags: { env: "test" },
          consistency: "Session",
          ipRules: [],
        }),
      );
      expect(account.accountName).toMatch(/^[a-z0-9][a-z0-9-]{1,42}[a-z0-9]$/);
      expect(account.kind).toEqual("GlobalDocumentDB");
      expect(account.location).toEqual(COSMOS_LOCATION);
      expect(account.documentEndpoint).toContain(
        `${account.accountName}.documents.azure.com`,
      );
      expect(account.capabilities).toContain("EnableServerless");
      expect(account.tags).toEqual({ env: "test" });

      const observed = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.consistencyPolicy?.defaultConsistencyLevel).toEqual(
        "Session",
      );
      expect(observed.properties?.minimalTlsVersion).toEqual("Tls12");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Account");

      // In-place updates: tags, consistency, and firewall rules (one PATCH).
      const updated = yield* stack.deploy(
        program({
          tags: { env: "prod" },
          consistency: "Eventual",
          ipRules: ["203.0.113.10"],
        }),
      );
      expect(updated.account.accountName).toEqual(account.accountName);
      expect(updated.account.tags).toEqual({ env: "prod" });
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(
        reobserved.properties?.consistencyPolicy?.defaultConsistencyLevel,
      ).toEqual("Eventual");
      expect(
        (reobserved.properties?.ipRules ?? []).map((r) => r.ipAddressOrRange),
      ).toEqual(["203.0.113.10"]);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAccount(group.resourceGroupName, account.accountName),
          60,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 1_500_000,
  },
);
