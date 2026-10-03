import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { tags?: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.DataShare.Account("Account", {
      resourceGroup: group.resourceGroupName,
      tags: props.tags,
    });
    return { group, account };
  });

// Data Share accounts are free; ~1-2 minutes to create.
test.provider(
  "create, update tags, and delete a data share account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const get = () =>
        Effect.gen(function* () {
          return yield* datashare.GetAccount({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
          });
        });
      expect(account.principalId).not.toEqual("");
      expect(account.provisioningState).toEqual("Succeeded");
      const observed = yield* get();
      expect(observed.identity.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Account");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod", team: "data" } }),
      );
      expect(updated.account.accountId).toEqual(account.accountId);
      expect(updated.account.tags).toEqual({ env: "prod", team: "data" });
      const reobserved = yield* get();
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("data");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
