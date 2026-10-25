import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as purview from "@distilled.cloud/azure/purview";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { getAccount, gone, location, logLevel, softDeleted, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  tags: Record<string, string>;
  managedResourceGroupName: string;
  publicNetworkAccess: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const account = yield* Azure.Purview.Account("Catalog", {
      resourceGroup: group.resourceGroupName,
      location,
      managedResourceGroupName: props.managedResourceGroupName,
      managedEventHubState: "Disabled",
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, account };
  });

// ~$1/run (Data Map capacity units are billed per hour while the account
// exists, plus the managed storage account), 30-45 min (create, update,
// create-before-delete replacement, delete). A tenant can create only one
// Purview account, and Azure reconciles the first one into the tenant-level
// Microsoft Purview account (enterprise version) — a tenant-wide change
// that outlives the test. The replacement step needs room for two accounts
// in the tenant quota. Run only with AZURE_TEST_PAID=1 on a tenant set
// aside for it.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a purview account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({
          tags: { env: "test" },
          managedResourceGroupName: "alchemy-purview-managed-1",
          publicNetworkAccess: "Enabled",
        }),
      );
      const rg = group.resourceGroupName;
      expect(account.accountName).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
      expect(account.managedResourceGroupName).toEqual("alchemy-purview-managed-1");
      expect(account.identityType).toEqual("SystemAssigned");
      expect(account.principalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(account.catalogEndpoint).toContain(account.accountName);
      expect(account.tags).toEqual({ env: "test" });
      const observed = yield* getAccount(rg, account.accountName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Catalog");

      // In place: tags and public network access.
      const updated = yield* stack.deploy(
        program({
          tags: { env: "prod" },
          managedResourceGroupName: "alchemy-purview-managed-1",
          publicNetworkAccess: "Disabled",
        }),
      );
      expect(updated.account.accountName).toEqual(account.accountName);
      expect(updated.account.accountId).toEqual(account.accountId);
      const patched = yield* getAccount(rg, account.accountName);
      expect(patched.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(patched.tags?.env).toEqual("prod");

      // Replacement: the managed resource group name is create-only.
      const replaced = yield* stack.deploy(
        program({
          tags: { env: "prod" },
          managedResourceGroupName: "alchemy-purview-managed-2",
          publicNetworkAccess: "Disabled",
        }),
      );
      expect(replaced.account.accountName).not.toEqual(account.accountName);
      expect(replaced.account.managedResourceGroupName).toEqual("alchemy-purview-managed-2");
      expect(yield* gone(getAccount(rg, account.accountName), softDeleted)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* gone(getAccount(rg, replaced.account.accountName), softDeleted)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);

// Probe: a missing account reads as the typed `ResourceNotFound` that
// `read` and `delete` treat as gone, so a crashed create converges.
test.provider(
  "a missing purview account reads as ResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", { location });
          return { group };
        }),
      );
      const subscription = yield* subscriptionId;
      yield* ensureRegistered(subscription, "Microsoft.Purview");
      const error = yield* purview
        .GetAccount({
          subscriptionId: subscription,
          resourceGroupName: group.resourceGroupName,
          accountName: "alchemy-purview-missing",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
