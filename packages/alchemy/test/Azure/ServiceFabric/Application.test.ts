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

const getApplication = (
  resourceGroupName: string,
  clusterName: string,
  applicationName: string,
) =>
  Effect.gen(function* () {
    return yield* sf.GetApplication({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      applicationName,
    });
  });

const program = (props: {
  appPackageUrl: string;
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
      name: props.name,
      version: version.applicationTypeVersionId,
      tags: props.tags,
    });
    return { group, cluster, version, app };
  });

// Needs a cluster with nodes: 3 × Standard_D2s_v4 (6 vCPUs) at
// ~$0.60/hour, 20-40 minutes to provision and as long to delete. Also needs
// AZURE_TEST_SF_APP_PACKAGE_URL (see util.ts).
test.provider.skipIf(!runPaidOnly || appPackage.url === undefined)(
  "create, update, replace, and delete an application",
  (stack) =>
    withVcpus(4)(
      withPublicIps(1)(
        Effect.gen(function* () {
          yield* stack.destroy();
          const appPackageUrl = appPackage.url!;

          const { group, cluster, version, app } = yield* stack.deploy(
            program({ appPackageUrl, tags: { env: "test" } }),
          );
          const get = (name: string) =>
            getApplication(
              group.resourceGroupName,
              cluster.managedClusterName,
              name,
            );
          expect(app.version?.toLowerCase()).toEqual(
            version.applicationTypeVersionId.toLowerCase(),
          );
          const observed = yield* get(app.applicationName);
          expect(observed.properties?.provisioningState).toEqual("Succeeded");

          // In-place: tags.
          const updated = yield* stack.deploy(
            program({ appPackageUrl, tags: { env: "prod" } }),
          );
          expect(updated.app.applicationId).toEqual(app.applicationId);
          expect((yield* get(app.applicationName)).tags?.env).toEqual("prod");

          // Replacement: rename.
          const replaced = yield* stack.deploy(
            program({ appPackageUrl, tags: { env: "prod" }, name: "renamed" }),
          );
          expect(replaced.app.applicationName).toEqual("renamed");
          expect(yield* waitGone(get(app.applicationName))).toEqual("gone");

          yield* stack.destroy();
          expect(yield* waitGone(get("renamed"))).toEqual("gone");
        }),
      ),
    ).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
