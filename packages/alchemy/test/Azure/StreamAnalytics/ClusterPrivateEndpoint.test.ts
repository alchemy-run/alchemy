import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getEndpoint = (
  resourceGroupName: string,
  clusterName: string,
  privateEndpointName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* streamanalytics.GetPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      clusterName,
      privateEndpointName,
    });
  });

const endpointGone = (
  resourceGroupName: string,
  clusterName: string,
  privateEndpointName: string,
) =>
  getEndpoint(resourceGroupName, clusterName, privateEndpointName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 40,
    }),
  );

const program = (props: { groupId: "blob" | "queue" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      // Stream Analytics rejects resource group names over 80 characters.
      name: "alchemy-test-streamanalytics-cluster-pe",
      location: "eastus",
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const cluster = yield* Azure.StreamAnalytics.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
    });
    const endpoint = yield* Azure.StreamAnalytics.ClusterPrivateEndpoint(
      "Endpoint",
      {
        resourceGroup: group.resourceGroupName,
        cluster: cluster.clusterName,
        privateLinkServiceId: account.storageAccountId,
        groupIds: [props.groupId],
      },
    );
    return { group, account, cluster, endpoint };
  });

// Expensive: needs a 36-SU dedicated cluster (~$4-8/hour, hourly minimum,
// 30-90 minutes to create and delete). Estimated ~$10/run.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a cluster private endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, cluster, endpoint } = yield* stack.deploy(
        program({ groupId: "blob" }),
      );
      expect(endpoint.groupIds).toEqual(["blob"]);
      expect(endpoint.privateLinkServiceId.toLowerCase()).toEqual(
        account.storageAccountId.toLowerCase(),
      );
      const observed = yield* getEndpoint(
        group.resourceGroupName,
        cluster.clusterName,
        endpoint.privateEndpointName,
      );
      expect(
        observed.properties?.manualPrivateLinkServiceConnections?.[0]
          ?.properties?.groupIds,
      ).toEqual(["blob"]);

      // Replacement: the target sub-resource is immutable.
      const replaced = yield* stack.deploy(program({ groupId: "queue" }));
      expect(replaced.endpoint.groupIds).toEqual(["queue"]);
      expect(replaced.endpoint.privateEndpointName).not.toEqual(
        endpoint.privateEndpointName,
      );

      yield* stack.destroy();
      expect(
        yield* endpointGone(
          group.resourceGroupName,
          cluster.clusterName,
          replaced.endpoint.privateEndpointName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:streamanalytics", "live"],
    timeout: 900_000,
  },
);
