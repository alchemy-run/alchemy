import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kc from "@distilled.cloud/azure/kubernetesconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "eastus2";

const getExtension = (
  resourceGroupName: string,
  clusterName: string,
  extensionName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* kc.GetExtension({
      subscriptionId,
      resourceGroupName,
      clusterRp: "Microsoft.ContainerService",
      clusterResourceName: "managedClusters",
      clusterName,
      extensionName,
    });
  });

const program = (
  extension: Partial<Azure.KubernetesConfiguration.ExtensionProps> | undefined,
) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster(location);
    const flux =
      extension === undefined
        ? undefined
        : yield* Azure.KubernetesConfiguration.Extension("Flux", {
            clusterId: cluster.clusterId,
            extensionType: "microsoft.flux",
            ...extension,
          });
    return { group, cluster, flux };
  });

// Expensive in time: the 4-vCPU test cluster takes ~5.5 min to create and
// ~6-10 min to delete (~$0.10 per run), the free `microsoft.flux` extension
// ~1 min to install and ~2 min to uninstall; a full run takes ~20-25 min.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a cluster extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a Helm setting.
      const created = yield* stack.deploy(
        program({
          configurationSettings: { "multiTenancy.enforce": "false" },
        }),
      );
      const { group, cluster } = created;
      const flux = created.flux!;
      expect(flux.extensionType.toLowerCase()).toEqual("microsoft.flux");
      expect(flux.provisioningState).toEqual("Succeeded");
      expect(flux.clusterName).toEqual(cluster.clusterName);
      const observed = yield* getExtension(
        group.resourceGroupName,
        cluster.clusterName,
        flux.extensionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.configurationSettings?.["multiTenancy.enforce"],
      ).toEqual("false");

      // In-place update of the Helm settings.
      const updated = yield* stack.deploy(
        program({
          configurationSettings: {
            "multiTenancy.enforce": "false",
            "helm-controller.enabled": "false",
          },
        }),
      );
      expect(updated.flux!.extensionId).toEqual(flux.extensionId);
      const patched = yield* getExtension(
        group.resourceGroupName,
        cluster.clusterName,
        flux.extensionName,
      );
      expect(
        patched.properties?.configurationSettings?.["helm-controller.enabled"],
      ).toEqual("false");

      // Removing the extension uninstalls it while the cluster stays.
      yield* stack.deploy(program(undefined));
      expect(
        yield* untilGone(
          getExtension(
            group.resourceGroupName,
            cluster.clusterName,
            flux.extensionName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withPublicIps(1), withVcpus(4), logLevel),
  { tags: [...tags], timeout: 1_800_000 },
);
