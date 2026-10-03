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
  containerName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* storage.GetBlobContainerImmutabilityPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      containerName,
    });
  });

// A container without a policy reports an empty policy (period 0); a
// deleted account or container reports a typed not-found.
const policyGone = (rg: string, account: string, container: string) =>
  getPolicy(rg, account, container).pipe(
    Effect.map((policy) =>
      policy.properties.state === "Deleted" ||
      (policy.properties.immutabilityPeriodSinceCreationInDays ?? 0) === 0
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag(["ContainerNotFound", "ResourceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

type PolicySettings = Omit<
  Azure.Storage.ImmutabilityPolicyProps,
  "resourceGroup" | "storageAccount" | "container"
>;

const program = (policy?: PolicySettings) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const container = yield* Azure.Storage.BlobContainer("Archive", {
      resourceGroup: group.resourceGroupName,
      storageAccount: account.storageAccountName,
    });
    const retention = policy
      ? yield* Azure.Storage.ImmutabilityPolicy("Retention", {
          ...policy,
          resourceGroup: group.resourceGroupName,
          storageAccount: account.storageAccountName,
          container: container.containerName,
        })
      : undefined;
    return { group, account, container, retention };
  });

// Standard_LRS account with an empty container: ~$0, ~1 minute. The policy
// is never locked, so the container stays deletable.
test.provider(
  "create, update, and delete an unlocked immutability policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ immutabilityPeriodSinceCreationInDays: 1 }),
      );
      const rg = created.group.resourceGroupName;
      const acct = created.account.storageAccountName;
      const ctr = created.container.containerName;
      expect(created.retention!.state).toEqual("Unlocked");
      expect(created.retention!.immutabilityPeriodSinceCreationInDays).toEqual(
        1,
      );
      const observed = yield* getPolicy(rg, acct, ctr);
      expect(observed.properties.immutabilityPeriodSinceCreationInDays).toEqual(
        1,
      );

      // In-place update while unlocked.
      const updated = yield* stack.deploy(
        program({
          immutabilityPeriodSinceCreationInDays: 2,
          allowProtectedAppendWrites: true,
        }),
      );
      expect(updated.retention!.immutabilityPeriodSinceCreationInDays).toEqual(
        2,
      );
      const reobserved = yield* getPolicy(rg, acct, ctr);
      expect(
        reobserved.properties.immutabilityPeriodSinceCreationInDays,
      ).toEqual(2);
      expect(reobserved.properties.allowProtectedAppendWrites).toEqual(true);

      // Removing the resource aborts the policy; the container stays.
      yield* stack.deploy(program());
      expect(yield* policyGone(rg, acct, ctr)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:storage", "live"],
    timeout: 600_000,
  },
);
