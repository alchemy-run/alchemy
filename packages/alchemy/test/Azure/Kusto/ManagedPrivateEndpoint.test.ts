import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { devCluster, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  clusterName: string,
  managedPrivateEndpointName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetManagedPrivateEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      managedPrivateEndpointName,
    });
  });

const program = (props: { requestMessage: string }) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* devCluster();
    const account = yield* Azure.Storage.StorageAccount("Target", {
      resourceGroup: group.resourceGroupName,
    });
    const endpoint = yield* Azure.Kusto.ManagedPrivateEndpoint("Endpoint", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      privateLinkResourceId: account.storageAccountId,
      groupId: "blob",
      requestMessage: props.requestMessage,
    });
    return { group, cluster, account, endpoint };
  });

// Needs a Dev Kusto cluster (~$0.25/hour, 10-20 minutes to create, 5-10
// to delete) plus a storage account: ~$0.20 per run, ~30 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Kusto managed private endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, account, endpoint } = yield* stack.deploy(
        program({ requestMessage: "alchemy test" }),
      );
      const get = () =>
        getEndpoint(
          group.resourceGroupName,
          cluster.clusterName,
          endpoint.managedPrivateEndpointName,
        );
      const observed = yield* get();
      expect(observed.properties?.privateLinkResourceId.toLowerCase()).toEqual(
        account.storageAccountId.toLowerCase(),
      );
      expect(observed.properties?.groupId).toEqual("blob");
      expect(observed.properties?.requestMessage).toEqual("alchemy test");

      // In place: change the approval request message.
      const updated = yield* stack.deploy(
        program({ requestMessage: "alchemy test updated" }),
      );
      expect(updated.endpoint.managedPrivateEndpointId).toEqual(
        endpoint.managedPrivateEndpointId,
      );
      expect((yield* get()).properties?.requestMessage).toEqual(
        "alchemy test updated",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(), 60)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
