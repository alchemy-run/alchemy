import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kc from "@distilled.cloud/azure/kubernetesconfiguration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps, withVcpus } from "../gates.ts";
import { logLevel, tags, testCluster, untilGone } from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const location = "eastus2";
const repository = "https://github.com/Azure/arc-k8s-demo";

const getConfiguration = (
  resourceGroupName: string,
  clusterName: string,
  fluxConfigurationName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* kc.GetFluxConfiguration({
      subscriptionId,
      resourceGroupName,
      clusterRp: "Microsoft.ContainerService",
      clusterResourceName: "managedClusters",
      clusterName,
      fluxConfigurationName,
    });
  });

const program = (
  configuration:
    | Partial<Azure.KubernetesConfiguration.FluxConfigurationProps>
    | undefined,
) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster(location);
    const flux = yield* Azure.KubernetesConfiguration.Extension("Flux", {
      clusterId: cluster.clusterId,
      extensionType: "microsoft.flux",
    });
    const config =
      configuration === undefined
        ? undefined
        : yield* Azure.KubernetesConfiguration.FluxConfiguration("Config", {
            // Depend on the extension so Flux is installed first.
            clusterId: flux.clusterId,
            namespace: "flux-demo",
            gitRepository: {
              url: repository,
              repositoryRef: { branch: "master" },
            },
            kustomizations: { app: { path: "./namespaces", prune: true } },
            ...configuration,
          });
    return { group, cluster, flux, config };
  });

// Expensive in time: the 4-vCPU test cluster takes ~5.5 min to create and
// ~6-10 min to delete (~$0.10 per run), plus the free `microsoft.flux`
// extension (~1-10 min) and the configuration (~1 min each step); a full
// run takes ~25-35 min.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a flux configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({}));
      const { group, cluster } = created;
      const config = created.config!;
      expect(config.provisioningState).toEqual("Succeeded");
      expect(config.namespace).toEqual("flux-demo");
      expect(config.suspend).toEqual(false);
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        cluster.clusterName,
        config.fluxConfigurationName,
      );
      expect(observed.properties?.gitRepository?.url).toEqual(repository);
      expect(Object.keys(observed.properties?.kustomizations ?? {})).toEqual([
        "app",
      ]);

      // In-place update: suspend and change the sync interval.
      const updated = yield* stack.deploy(
        program({
          suspend: true,
          gitRepository: {
            url: repository,
            repositoryRef: { branch: "master" },
            syncIntervalInSeconds: 300,
          },
        }),
      );
      expect(updated.config!.fluxConfigurationId).toEqual(
        config.fluxConfigurationId,
      );
      expect(updated.config!.suspend).toEqual(true);
      const patched = yield* getConfiguration(
        group.resourceGroupName,
        cluster.clusterName,
        config.fluxConfigurationName,
      );
      expect(patched.properties?.suspend).toEqual(true);
      expect(patched.properties?.gitRepository?.syncIntervalInSeconds).toEqual(
        300,
      );

      // Changing the namespace replaces the configuration.
      const replaced = yield* stack.deploy(
        program({ namespace: "flux-demo-2", suspend: true }),
      );
      expect(replaced.config!.namespace).toEqual("flux-demo-2");
      expect(replaced.config!.fluxConfigurationName).not.toEqual(
        config.fluxConfigurationName,
      );
      expect(
        yield* untilGone(
          getConfiguration(
            group.resourceGroupName,
            cluster.clusterName,
            config.fluxConfigurationName,
          ),
        ),
      ).toEqual("gone");

      // Removing the configuration deletes it while the cluster stays.
      yield* stack.deploy(program(undefined));
      expect(
        yield* untilGone(
          getConfiguration(
            group.resourceGroupName,
            cluster.clusterName,
            replaced.config!.fluxConfigurationName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withPublicIps(1), withVcpus(4), logLevel),
  { tags: [...tags], timeout: 2_400_000 },
);
