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

const getVersion = (
  resourceGroupName: string,
  clusterName: string,
  applicationTypeName: string,
  version: string,
) =>
  Effect.gen(function* () {
    return yield* sf.GetApplicationTypeVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationTypeName,
      version,
    });
  });

const program = (props: {
  appPackageUrl: string;
  tags: Record<string, string>;
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
        tags: props.tags,
      },
    );
    return { group, cluster, appType, version };
  });

// Provisioning a package needs a cluster with nodes: 3 × Standard_D2s_v3
// (6 vCPUs, over the free trial's ~4) at ~$0.60/hour, 20-40 minutes to
// provision. Also needs AZURE_TEST_SF_APP_PACKAGE_URL (see util.ts).
test.provider.skipIf(!runPaidOnly || appPackage.url === undefined)(
  "create, update, and delete an application type version",
  (stack) =>
    withVcpus(4)(
      withPublicIps(1)(
        Effect.gen(function* () {
          yield* stack.destroy();
          const appPackageUrl = appPackage.url!;

          const { group, cluster, appType, version } = yield* stack.deploy(
            program({ appPackageUrl, tags: { env: "test" } }),
          );
          const get = () =>
            getVersion(
              group.resourceGroupName,
              cluster.managedClusterName,
              appType.applicationTypeName,
              version.version,
            );
          expect(version.appPackageUrl).toEqual(appPackageUrl);
          const observed = yield* get();
          expect(observed.properties?.provisioningState).toEqual("Succeeded");

          // In-place: tags.
          const updated = yield* stack.deploy(
            program({ appPackageUrl, tags: { env: "prod" } }),
          );
          expect(updated.version.applicationTypeVersionId).toEqual(
            version.applicationTypeVersionId,
          );
          expect((yield* get()).tags?.env).toEqual("prod");

          yield* stack.destroy();
          expect(yield* waitGone(get())).toEqual("gone");
        }),
      ),
    ).pipe(logLevel),
  { tags, timeout: 900_000 },
);
