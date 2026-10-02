import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/azure/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  accountName: string,
  objectReplicationPolicyId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetObjectReplicationPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      objectReplicationPolicyId,
    });
  });

const policyGone = (
  resourceGroupName: string,
  accountName: string,
  policyId: string,
) =>
  getPolicy(resourceGroupName, accountName, policyId).pipe(
    Effect.as("found" as const),
    Effect.catchTag("ObjectReplicationPolicyNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

type Mode = "none" | "one" | "two";

const program = (mode: Mode) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const source = yield* Azure.Storage.StorageAccount("Source", {
      resourceGroup: group.resourceGroupName,
    });
    const destination = yield* Azure.Storage.StorageAccount("Destination", {
      resourceGroup: group.resourceGroupName,
    });
    const sourceBlob = yield* Azure.Storage.BlobServiceProperties(
      "SourceBlob",
      {
        resourceGroup: group.resourceGroupName,
        storageAccount: source.storageAccountName,
        isVersioningEnabled: true,
        changeFeed: { enabled: true },
      },
    );
    const destinationBlob = yield* Azure.Storage.BlobServiceProperties(
      "DestinationBlob",
      {
        resourceGroup: group.resourceGroupName,
        storageAccount: destination.storageAccountName,
        isVersioningEnabled: true,
      },
    );
    const images = yield* Azure.Storage.BlobContainer("Images", {
      resourceGroup: group.resourceGroupName,
      storageAccount: source.storageAccountName,
    });
    const imagesCopy = yield* Azure.Storage.BlobContainer("ImagesCopy", {
      resourceGroup: group.resourceGroupName,
      storageAccount: destination.storageAccountName,
    });
    const docs = yield* Azure.Storage.BlobContainer("Docs", {
      resourceGroup: group.resourceGroupName,
      storageAccount: source.storageAccountName,
    });
    const docsCopy = yield* Azure.Storage.BlobContainer("DocsCopy", {
      resourceGroup: group.resourceGroupName,
      storageAccount: destination.storageAccountName,
    });
    const policy =
      mode === "none"
        ? undefined
        : yield* Azure.Storage.ObjectReplicationPolicy("Replication", {
            resourceGroup: group.resourceGroupName,
            sourceAccount: sourceBlob.storageAccount,
            destinationAccount: destinationBlob.storageAccount,
            rules:
              mode === "one"
                ? [
                    {
                      sourceContainer: images.containerName,
                      destinationContainer: imagesCopy.containerName,
                    },
                  ]
                : [
                    {
                      sourceContainer: images.containerName,
                      destinationContainer: imagesCopy.containerName,
                      prefixMatch: ["published/"],
                    },
                    {
                      sourceContainer: docs.containerName,
                      destinationContainer: docsCopy.containerName,
                    },
                  ],
          });
    return { group, source, destination, images, docs, policy };
  });

// Two empty Standard_LRS accounts with versioning/change feed: ~$0,
// ~2 minutes.
test.provider(
  "create, update, and delete an object replication policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("one"));
      const rg = created.group.resourceGroupName;
      const src = created.source.storageAccountName;
      const dst = created.destination.storageAccountName;
      const policyId = created.policy!.policyId;
      expect(policyId).not.toEqual("default");
      expect(created.policy!.rules).toHaveLength(1);
      const ruleId = created.policy!.rules[0]!.ruleId;
      expect(ruleId.length).toBeGreaterThan(0);

      // Both sides carry the same policy and rule IDs.
      const onDestination = yield* getPolicy(rg, dst, policyId);
      const onSource = yield* getPolicy(rg, src, policyId);
      expect(onDestination.properties?.rules?.[0]?.ruleId).toEqual(ruleId);
      expect(onSource.properties?.rules?.[0]?.ruleId).toEqual(ruleId);
      expect(onSource.properties?.rules?.[0]?.sourceContainer).toEqual(
        created.images.containerName,
      );

      // In-place update: add a prefix filter and a second container pair.
      const updated = yield* stack.deploy(program("two"));
      expect(updated.policy!.policyId).toEqual(policyId);
      expect(updated.policy!.rules).toHaveLength(2);
      const reobserved = yield* getPolicy(rg, src, policyId);
      const rules = reobserved.properties?.rules ?? [];
      expect(rules).toHaveLength(2);
      const imagesRule = rules.find(
        (rule) => rule.sourceContainer === created.images.containerName,
      );
      expect(imagesRule?.ruleId).toEqual(ruleId);
      expect(imagesRule?.filters?.prefixMatch).toEqual(["published/"]);

      // Removing the resource deletes the policy from both accounts.
      yield* stack.deploy(program("none"));
      expect(yield* policyGone(rg, dst, policyId)).toEqual("gone");
      expect(yield* policyGone(rg, src, policyId)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
