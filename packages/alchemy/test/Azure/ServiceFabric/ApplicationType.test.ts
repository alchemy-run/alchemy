import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps } from "../gates.ts";
import { clusterAuth, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplicationType = (
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
) =>
  Effect.gen(function* () {
    return yield* sf.GetApplicationType({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationTypeName,
    });
  });

const program = (props: { name: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "westus2",
    });
    const cluster = yield* Azure.ServiceFabric.ManagedCluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      ...clusterAuth,
    });
    const appType = yield* Azure.ServiceFabric.ApplicationType("AppType", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.managedClusterName,
      name: props.name,
      tags: props.tags,
    });
    return { group, cluster, appType };
  });

// Application types are ARM-side registrations: they do not need nodes,
// so a node-less Basic cluster (~$0.01 per run, ~5 minutes) is enough.
test.provider(
  "create, update, replace, and delete an application type",
  (stack) =>
    withPublicIps(1)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, cluster, appType } = yield* stack.deploy(
          program({ name: "AlchemyTestType", tags: { env: "test" } }),
        );
        const get = (name: string) =>
          getApplicationType(
            group.resourceGroupName,
            cluster.managedClusterName,
            name,
          );
        expect(appType.applicationTypeName).toEqual("AlchemyTestType");
        const observed = yield* get("AlchemyTestType");
        expect(observed.tags?.env).toEqual("test");

        // In-place: tags.
        const updated = yield* stack.deploy(
          program({ name: "AlchemyTestType", tags: { env: "prod" } }),
        );
        expect(updated.appType.applicationTypeId).toEqual(
          appType.applicationTypeId,
        );
        expect((yield* get("AlchemyTestType")).tags?.env).toEqual("prod");

        // Replacement: the name is the identity.
        const replaced = yield* stack.deploy(
          program({ name: "AlchemyTestType2", tags: { env: "prod" } }),
        );
        expect(replaced.appType.applicationTypeName).toEqual(
          "AlchemyTestType2",
        );
        expect((yield* get("AlchemyTestType2")).tags?.env).toEqual("prod");
        expect(yield* waitGone(get("AlchemyTestType"))).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(
            sf.GetManagedCluster({
              subscriptionId: yield* subscription,
              resourceGroupName: group.resourceGroupName,
              clusterName: cluster.managedClusterName,
            }),
          ),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
