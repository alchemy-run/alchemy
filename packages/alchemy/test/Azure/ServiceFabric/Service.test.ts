import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sf from "@distilled.cloud/azure/servicefabricmanagedclusters";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly, withPublicIps, withVcpus } from "../gates.ts";
import {
  appPackage,
  clusterWithNodes,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
  serviceName: string,
) =>
  Effect.gen(function* () {
    return yield* sf.GetService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationName,
      serviceName,
    });
  });

const program = (props: {
  appPackageUrl: string;
  instanceCount: number;
  tags: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const { group, cluster, nodeType } = yield* clusterWithNodes;
    const appType = yield* Azure.ServiceFabric.ApplicationType("AppType", {
      resourceGroup: group.resourceGroupName,
      cluster: nodeType.cluster,
      name: appPackage.appTypeName,
    });
    const version = yield* Azure.ServiceFabric.ApplicationTypeVersion(
      "Version",
      {
        resourceGroup: group.resourceGroupName,
        cluster: cluster.managedClusterName,
        applicationType: appType.applicationTypeName,
        version: appPackage.appTypeVersion,
        appPackageUrl: props.appPackageUrl,
      },
    );
    const app = yield* Azure.ServiceFabric.Application("App", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.managedClusterName,
      version: version.applicationTypeVersionId,
    });
    const service = yield* Azure.ServiceFabric.Service("Web", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.managedClusterName,
      application: app.applicationName,
      name: props.name,
      serviceKind: "Stateless",
      serviceTypeName: appPackage.serviceTypeName,
      partitionDescription: { partitionScheme: "Singleton" },
      instanceCount: props.instanceCount,
      tags: props.tags,
    });
    return { group, cluster, app, service };
  });

// Needs a cluster with nodes: 3 × Standard_D2s_v4 (6 vCPUs) at
// ~$0.60/hour, 20-40 minutes to provision and as long to delete. Also needs
// AZURE_TEST_SF_APP_PACKAGE_URL (see util.ts).
test.provider.skipIf(!runPaidOnly || appPackage.url === undefined)(
  "create, update, replace, and delete a stateless service",
  (stack) =>
    withVcpus(4)(
      withPublicIps(1)(
        Effect.gen(function* () {
          yield* stack.destroy();
          const appPackageUrl = appPackage.url!;

          const { group, cluster, app, service } = yield* stack.deploy(
            program({ appPackageUrl, instanceCount: 1, tags: { env: "test" } }),
          );
          const get = (name: string) =>
            getService(
              group.resourceGroupName,
              cluster.managedClusterName,
              app.applicationName,
              name,
            );
          expect(service.serviceKind).toEqual("Stateless");
          const observed = yield* get(service.serviceName);
          expect(observed.properties?.instanceCount).toEqual(1);

          // In-place: instance count and tags.
          const updated = yield* stack.deploy(
            program({ appPackageUrl, instanceCount: 2, tags: { env: "prod" } }),
          );
          expect(updated.service.serviceId).toEqual(service.serviceId);
          const reobserved = yield* get(service.serviceName);
          expect(reobserved.properties?.instanceCount).toEqual(2);
          expect(reobserved.tags?.env).toEqual("prod");

          // Replacement: rename.
          const replaced = yield* stack.deploy(
            program({
              appPackageUrl,
              instanceCount: 2,
              tags: { env: "prod" },
              name: "web2",
            }),
          );
          expect(replaced.service.serviceName).toEqual("web2");
          expect(yield* waitGone(get(service.serviceName))).toEqual("gone");

          yield* stack.destroy();
          expect(yield* waitGone(get("web2"))).toEqual("gone");
        }),
      ),
    ).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
