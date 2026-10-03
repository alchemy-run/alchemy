import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscription,
  tags,
  testCertificate,
  testNodeTypes,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplicationType = (
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
) =>
  Effect.gen(function* () {
    return yield* servicefabric.GetApplicationType({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationTypeName,
    });
  });

const program = (props: { tags: Record<string, string>; name?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.ServiceFabricClassic.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      reliabilityLevel: "None",
      certificate: testCertificate,
      nodeTypes: testNodeTypes(),
    });
    const appType = yield* Azure.ServiceFabricClassic.ApplicationType(
      "AppType",
      {
        resourceGroup: group.resourceGroupName,
        cluster: cluster.clusterName,
        name: props.name,
        tags: props.tags,
      },
    );
    return { group, cluster, appType };
  });

// Application types are ARM-side records: they can be created on a cluster
// that is still `WaitingForNodes` (no VMs), so this test is free and fast.
test.provider(
  "create, update, replace, and delete a classic service fabric application type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, appType } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(appType.provisioningState).toEqual("Succeeded");
      const observed = yield* getApplicationType(
        group.resourceGroupName,
        cluster.clusterName,
        appType.applicationTypeName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("AppType");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.appType.applicationTypeId).toEqual(
        appType.applicationTypeId,
      );
      expect(
        (yield* getApplicationType(
          group.resourceGroupName,
          cluster.clusterName,
          appType.applicationTypeName,
        )).tags?.env,
      ).toEqual("prod");

      // Replacement: a new name (must match the manifest's type name).
      const replaced = yield* stack.deploy(
        program({ tags: { env: "prod" }, name: "VotingType" }),
      );
      expect(replaced.appType.applicationTypeName).toEqual("VotingType");
      expect(
        yield* waitGone(
          getApplicationType(
            group.resourceGroupName,
            cluster.clusterName,
            appType.applicationTypeName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getApplicationType(
            group.resourceGroupName,
            cluster.clusterName,
            "VotingType",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
