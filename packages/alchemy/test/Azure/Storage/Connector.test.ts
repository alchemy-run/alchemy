import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const PROBE_URI =
  "azds://eastus:alchemyprobe:00000000-0000-0000-0000-000000000000";

const getConnector = (rg: string, account: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetConnector({
      subscriptionId,
      resourceGroupName: rg,
      accountName: account,
      connectorName: name,
    });
  });

const connectorGone = (rg: string, account: string, name: string) =>
  getConnector(rg, account, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ResourceNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const account = yield* Azure.Storage.StorageAccount("Account", {
    resourceGroup: group.resourceGroupName,
  });
  const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Reader", {
    resourceGroup: group.resourceGroupName,
  });
  return { group, account, identity };
});

// Storage connectors are a preview that needs subscription enrollment and
// a data share from a sharing party; the endpoint is not routed for the
// trial subscription. Standard_LRS
// account + identity: ~$0, ~1 minute.
test.provider(
  "probe: storage connectors are not available on the trial subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, account, identity } = yield* stack.deploy(base);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* storage
        .CreateConnector({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.storageAccountName,
          connectorName: "alchemy-probe",
          location: "eastus",
          properties: {
            dataSourceType: "Azure_DataShare",
            source: {
              type: "DataShare",
              connection: { type: "DataShare", dataShareUri: PROBE_URI },
              authProperties: {
                type: "ManagedIdentity",
                identityResourceId: identity.identityId,
              },
            },
          },
        })
        .pipe(Effect.flip);
      // ARM does not route the preview endpoint for this subscription: a
      // bare 404 "The request url .../connectors/alchemy-probe?... is not
      // found." with no ARM error code, so only the status tag is available.
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("/connectors/alchemy-probe");
      expect(error.message).toContain("is not found");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);

const program = (connector?: {
  description: string;
  state?: "Active" | "Inactive";
}) =>
  Effect.gen(function* () {
    const resources = yield* base;
    const shared = connector
      ? yield* Azure.Storage.Connector("Shared", {
          resourceGroup: resources.group.resourceGroupName,
          storageAccount: resources.account.storageAccountName,
          dataShareUri: process.env.AZURE_TEST_DATA_SHARE_URI ?? PROBE_URI,
          identityResourceId: resources.identity.identityId,
          ...connector,
        })
      : undefined;
    return { ...resources, shared };
  });

// Needs an enrolled subscription and a real data share URI in
// AZURE_TEST_DATA_SHARE_URI (shared with the Reader identity). Connector
// billing is per data-plane use: ~$0 for the lifecycle, ~2 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a storage connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ description: "first" }));
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const name = created.shared!.connectorName;
      expect(created.shared!.state).toEqual("Active");
      const observed = yield* getConnector(rg, acct, name);
      expect(observed.properties.description).toEqual("first");

      // In-place update: description and state.
      yield* stack.deploy(
        program({ description: "second", state: "Inactive" }),
      );
      const reobserved = yield* getConnector(rg, acct, name);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.properties.state).toEqual("Inactive");

      yield* stack.deploy(program());
      expect(yield* connectorGone(rg, acct, name)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 900_000,
  },
);
