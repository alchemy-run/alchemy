import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as discovery from "@distilled.cloud/azure/discovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  probeGroup,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (
  resourceGroupName: string,
  storageContainerName: string,
) =>
  Effect.gen(function* () {
    return yield* discovery.GetStorageContainer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      storageContainerName,
    });
  });

const program = (props: {
  account: "First" | "Second";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    // Both accounts stay deployed across the replacement step.
    const first = yield* Azure.Storage.StorageAccount("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.Storage.StorageAccount("Second", {
      resourceGroup: group.resourceGroupName,
    });
    const account = props.account === "First" ? first : second;
    const container = yield* Azure.Discovery.StorageContainer("Container", {
      resourceGroup: group.resourceGroupName,
      storageStore: {
        kind: "AzureStorageBlob",
        storageAccountId: account.storageAccountId,
      },
      tags: props.tags,
    });
    return { group, account, container };
  });

// Microsoft Discovery is a gated preview: ARM does not expose its resource
// types to the trial subscription (InvalidResourceType, see the probe).
// Two Standard_LRS accounts plus a control-plane registration: ~$0.01 per
// run on an onboarded subscription with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a discovery storage container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, container } = yield* stack.deploy(
        program({ account: "First", tags: { env: "test" } }),
      );
      const observed = yield* getContainer(
        group.resourceGroupName,
        container.storageContainerName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.storageStore.storageAccountId?.toLowerCase(),
      ).toEqual(account.storageAccountId.toLowerCase());
      expect(observed.tags?.env).toEqual("test");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ account: "First", tags: { env: "prod" } }),
      );
      expect(updated.container.storageContainerId).toEqual(
        container.storageContainerId,
      );
      const reobserved = yield* getContainer(
        group.resourceGroupName,
        container.storageContainerName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // The store is create-only: a different account replaces the container.
      const replaced = yield* stack.deploy(
        program({ account: "Second", tags: { env: "prod" } }),
      );
      expect(replaced.container.storageContainerName).not.toEqual(
        container.storageContainerName,
      );
      expect(replaced.container.storeResourceId?.toLowerCase()).toEqual(
        replaced.account.storageAccountId.toLowerCase(),
      );
      expect(
        yield* waitGone(
          getContainer(group.resourceGroupName, container.storageContainerName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getContainer(
            group.resourceGroupName,
            replaced.container.storageContainerName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

test.provider(
  "discovery storage containers are rejected where the preview is not enabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(probeGroup);
      const subscriptionId = yield* subscription;
      const error = yield* discovery
        .StorageContainersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          storageContainerName: "alchemy-probe",
          location,
          properties: {
            storageStore: {
              kind: "AzureStorageBlob",
              storageAccountId: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Storage/storageAccounts/alchemyprobe`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
