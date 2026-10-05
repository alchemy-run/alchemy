import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  kind: Azure.CognitiveServices.AccountKind;
  publicNetworkAccess: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
      kind: props.kind,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, account };
  });

// S0 is pay-per-call: an idle account costs $0; ~1 minute to provision.
test.provider(
  "create, update, replace, and delete (purge) an account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const get = (resourceGroupName: string, accountName: string) =>
        cognitiveservices.GetAccount({
          subscriptionId,
          resourceGroupName,
          accountName,
        });
      const getDeleted = (resourceGroupName: string, accountName: string) =>
        cognitiveservices.GetDeletedAccount({
          subscriptionId,
          location: "eastus",
          resourceGroupName,
          accountName,
        });

      const { group, account } = yield* stack.deploy(
        program({
          kind: "AIServices",
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      expect(account.kind).toEqual("AIServices");
      expect(account.customSubDomainName).toEqual(account.accountName);
      const observed = yield* get(group.resourceGroupName, account.accountName);
      expect(observed.sku?.name).toEqual("S0");
      expect(observed.properties?.endpoint).toEqual(
        `https://${account.accountName}.cognitiveservices.azure.com/`,
      );
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Account");

      // In place: public network access and tags.
      const updated = yield* stack.deploy(
        program({
          kind: "AIServices",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.account.accountId).toEqual(account.accountId);
      const reobserved = yield* get(
        group.resourceGroupName,
        account.accountName,
      );
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the kind is immutable.
      const replaced = yield* stack.deploy(
        program({
          kind: "ContentSafety",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.account.accountName).not.toEqual(account.accountName);
      const replacedObserved = yield* get(
        group.resourceGroupName,
        replaced.account.accountName,
      );
      expect(replacedObserved.kind).toEqual("ContentSafety");
      expect(
        yield* waitGone(get(group.resourceGroupName, account.accountName)),
      ).toEqual("gone");
      expect(
        yield* waitGone(
          getDeleted(group.resourceGroupName, account.accountName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDeleted(group.resourceGroupName, replaced.account.accountName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
