import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as codesigning from "@distilled.cloud/azure/codesigning";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
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

// Artifact Signing rejects free-trial subscriptions. On a paid subscription
// the full monthly fee is billed on creation, not prorated: Basic $9.99,
// Premium $99.99 (the SKU update below) — ~$110 per run, ~1-2 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete an artifact signing account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(account.sku).toEqual("Basic");
      expect(account.accountUri).toMatch(/^https:\/\//);
      const observed = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(observed.properties?.sku?.name).toEqual("Basic");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toBeDefined();

      // In-place: tags and SKU.
      const updated = yield* stack.deploy(
        program({ sku: "Premium", tags: { env: "prod" } }),
      );
      expect(updated.account.accountId).toEqual(account.accountId);
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(reobserved.properties?.sku?.name).toEqual("Premium");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(getAccount(group.resourceGroupName, account.accountName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free: name check + a rejected PUT in an empty resource
// group). The free trial rejects account creation with the typed error.
test.provider(
  "a free-trial subscription rejects artifact signing accounts with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subscriptionId = yield* subscription;
      const availability =
        yield* codesigning.CheckCodeSigningAccountNameAvailability({
          subscriptionId,
          type: "Microsoft.CodeSigning/codeSigningAccounts",
          name: "alchemyprobe7c1",
        });
      expect(typeof availability.nameAvailable).toEqual("boolean");

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* codesigning
        .CreateCodeSigningAccount({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: "alchemyprobe7c1",
          location: "eastus",
          properties: { sku: { name: "Basic" } },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CodeSigningSubscriptionNotSupported");
      expect(
        yield* waitGone(getAccount(group.resourceGroupName, "alchemyprobe7c1")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
