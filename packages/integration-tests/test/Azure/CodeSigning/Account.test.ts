import * as Azure from "@alchemy.run/azure";
import * as codesigning from "@distilled.cloud/azure/codesigning";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    return yield* codesigning.GetCodeSigningAccount({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
    });
  });

const program = (props: {
  sku?: Azure.CodeSigning.CodeSigningAccountSku;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CodeSigning.Account("Signing", {
      resourceGroup: group.resourceGroupName,
      sku: props.sku,
      tags: props.tags,
    });
    return { group, account };
  });

// The full monthly fee is billed on creation, not prorated: Basic $9.99,
// Premium $99.99 (the SKU update below) — ~$110 per run, ~1-2 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an artifact signing account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(account.sku).toEqual("Basic");
      expect(account.accountUri).toMatch(/^https:\/\//);
      const observed = yield* getAccount(group.resourceGroupName, account.accountName);
      expect(observed.properties?.sku?.name).toEqual("Basic");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Signing");

      // In-place: tags and SKU.
      const updated = yield* stack.deploy(program({ sku: "Premium", tags: { env: "prod" } }));
      expect(updated.account.accountId).toEqual(account.accountId);
      const reobserved = yield* getAccount(group.resourceGroupName, account.accountName);
      expect(reobserved.properties?.sku?.name).toEqual("Premium");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(getAccount(group.resourceGroupName, account.accountName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Free, no resources: the testing subscription is pay-as-you-go, so a
// create here would succeed and bill the $9.99 Basic fee. Only the name
// check runs ungated.
test.provider(
  "an unused artifact signing account name is reported available",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subscriptionId = yield* subscription;
      const availability = yield* codesigning.CheckCodeSigningAccountNameAvailability({
        subscriptionId,
        type: "Microsoft.CodeSigning/codeSigningAccounts",
        name: "alchemynamecheck7c1",
      });
      expect(availability.nameAvailable).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
