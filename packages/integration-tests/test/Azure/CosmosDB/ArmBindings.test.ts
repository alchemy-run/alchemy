import * as Azure from "@alchemy.run/azure";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  awaitGrants,
  awaitNoGrants,
  azure,
  call,
  expectOk,
  probe,
} from "../arm-action-bindings.ts";
import { runExpensive } from "../gates.ts";
import CosmosArmFunction, { Account, FIRST, SECOND } from "./fixtures/arm-function.ts";

const tags = ["provider:azure", "provider:azure:cosmosdb", "live"];

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureCosmosArmBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* CosmosArmFunction;
    const account = yield* Account;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: account.resourceGroup,
      accountName: account.accountName,
      accountId: account.accountId,
    };
  }),
);

// An empty two-region account (no databases: ~$0) plus a Flex Consumption
// app, but a second region takes 15-25 min to add and a failover another
// 5-15 min, so the suite runs only with AZURE_TEST_EXPENSIVE=1.
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 2_700_000 }) : undefined;

const url = Effect.suspend(() => Effect.map(stack!, (outputs) => outputs.url));

const accountRef = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const { resourceGroup, accountName } = yield* stack!;
  return { subscriptionId, resourceGroupName: resourceGroup, accountName };
});

/** The account's write region, polled until it is `region`. */
const untilWriteRegion = (region: string) =>
  Effect.gen(function* () {
    const ref = yield* accountRef;
    return yield* cosmos.GetDatabaseAccount(ref).pipe(
      Effect.map((account) =>
        account.properties?.writeLocations?.[0]?.locationName?.replace(/\s+/g, "").toLowerCase(),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("20 seconds"),
        until: (observed) => observed === region,
        times: 45,
      }),
    );
  }).pipe(Effect.provide(azure));

// Ungated: the binding's request, with the identifiers it derives from the
// bound account's ARM ID, reaches ARM's route for the action.
describe("Cosmos DB runtime-action requests", { tags }, () => {
  test(
    "CosmosDB.ChangeFailoverPriority addresses the bound account",
    Effect.gen(function* () {
      const tag = yield* probe("Microsoft.DocumentDB/databaseAccounts/cosmosprobe", (id) =>
        cosmos.DatabaseAccountsFailoverPriorityChange({
          subscriptionId: id.subscriptionId,
          resourceGroupName: id.resourceGroupName,
          accountName: id.name("databaseAccounts"),
          failoverPolicies: [{ locationName: FIRST, failoverPriority: 0 }],
        }),
      );
      expect(tag).toEqual("ResourceGroupNotFound");
    }),
  );
});

describe.skipIf(!runExpensive)("Cosmos DB account bindings on an Azure Function", { tags }, () => {
  describe("CosmosDB.ChangeFailoverPriority", () => {
    test(
      "moves the bound account's write region",
      Effect.gen(function* () {
        expect(yield* untilWriteRegion(FIRST)).toEqual(FIRST);
        const body = yield* call(url, "/promote-second");
        expectOk(body);
        expect(yield* untilWriteRegion(SECOND)).toEqual(SECOND);
      }),
      { timeout: 1_200_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly the failover-priority action on the account only",
      Effect.gen(function* () {
        const outputs = yield* stack!;
        const grants = yield* awaitGrants(outputs.principalId!, outputs.hostStorageAccount, 1);
        expect(grants).toEqual([
          `Microsoft.DocumentDB/databaseAccounts/failoverPriorityChange/action ${outputs.accountId.toLowerCase()}`,
        ]);
      }),
      { timeout: 300_000 },
    );
  });
});

if (runExpensive) {
  // Destroy, then prove the account and every role on the Function's identity are gone.
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { principalId, hostStorageAccount } = yield* stack!;
      const ref = yield* accountRef;
      yield* destroy(Stack);
      expect(yield* awaitNoGrants(principalId!, hostStorageAccount)).toEqual([]);
      const status = yield* cosmos.GetDatabaseAccount(ref).pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("20 seconds"),
          until: (observed) => observed === "gone",
          times: 45,
        }),
      );
      expect(status).toEqual("gone");
    }).pipe(Effect.provide(azure)),
    { timeout: 2_700_000 },
  );
}
