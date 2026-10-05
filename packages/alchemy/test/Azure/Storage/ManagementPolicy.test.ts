import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetManagementPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      managementPolicyName: "default",
    });
  });

const policyGone = (resourceGroupName: string, accountName: string) =>
  getPolicy(resourceGroupName, accountName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ManagementPolicyNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (rules?: Azure.Storage.LifecycleRule[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const policy = rules
      ? yield* Azure.Storage.ManagementPolicy("Lifecycle", {
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          rules,
        })
      : undefined;
    return { group, account, policy };
  });

test.provider(
  "create, update, and delete a lifecycle management policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program([
          {
            name: "expireLogs",
            filters: { blobTypes: ["blockBlob"], prefixMatch: ["logs/"] },
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } },
            },
          },
        ]),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      expect(created.policy!.ruleNames).toEqual(["expireLogs"]);
      const observed = yield* getPolicy(rg, acct);
      const rule = observed.properties?.policy.rules[0];
      expect(rule?.name).toEqual("expireLogs");
      expect(
        rule?.definition.actions.baseBlob?.delete
          ?.daysAfterModificationGreaterThan,
      ).toEqual(30);

      // In-place update: tier to cool instead of delete, plus a second rule.
      const updated = yield* stack.deploy(
        program([
          {
            name: "expireLogs",
            filters: { blobTypes: ["blockBlob"], prefixMatch: ["logs/"] },
            actions: {
              baseBlob: { tierToCool: { daysAfterModificationGreaterThan: 7 } },
            },
          },
          {
            name: "pruneSnapshots",
            enabled: false,
            actions: {
              snapshot: { delete: { daysAfterCreationGreaterThan: 90 } },
            },
          },
        ]),
      );
      expect(updated.policy!.ruleNames).toEqual([
        "expireLogs",
        "pruneSnapshots",
      ]);
      const reobserved = yield* getPolicy(rg, acct);
      const rules = reobserved.properties?.policy.rules ?? [];
      expect(
        rules[0]?.definition.actions.baseBlob?.tierToCool
          ?.daysAfterModificationGreaterThan,
      ).toEqual(7);
      expect(rules[0]?.definition.actions.baseBlob?.delete).toBeUndefined();
      expect(rules[1]?.enabled).toEqual(false);

      // Removing the resource deletes the policy.
      yield* stack.deploy(program());
      expect(yield* policyGone(rg, acct)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
