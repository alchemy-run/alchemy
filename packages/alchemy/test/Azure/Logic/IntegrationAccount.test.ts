import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

// One Free account per region per subscription: this file owns westus2.
const location = "westus2";

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const account = yield* Azure.Logic.IntegrationAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location,
      tags: props.tags,
    });
    return { group, account };
  });

const getAccount = (resourceGroupName: string, integrationAccountName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccount({
      subscriptionId: yield* subscription,
      resourceGroupName,
      integrationAccountName,
    });
  });

// Free SKU: no cost, provisions synchronously. A replacement step is not
// covered: replacements create first, and a second Free account in the
// same region is rejected.
test.provider(
  "create, update, and delete a Free integration account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({ tags: { env: "a" } }),
      );
      expect(account.sku).toEqual("Free");
      expect(account.state).toEqual("Enabled");
      expect(account.location).toEqual(location);
      expect(account.tags).toEqual({ env: "a" });
      const observed = yield* getAccount(
        group.resourceGroupName,
        account.integrationAccountName,
      );
      expect(observed.sku?.name).toEqual("Free");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Account");

      // In-place: tags. (SKU upgrades are billed; state is read-only.)
      const updated = yield* stack.deploy(
        program({ tags: { env: "b", team: "b2b" } }),
      );
      expect(updated.account.integrationAccountId).toEqual(
        account.integrationAccountId,
      );
      expect(updated.account.tags).toEqual({ env: "b", team: "b2b" });
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.integrationAccountName,
      );
      expect(reobserved.properties?.state).toEqual("Enabled");
      expect(reobserved.tags?.env).toEqual("b");
      expect(reobserved.tags?.team).toEqual("b2b");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAccount(group.resourceGroupName, account.integrationAccountName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
