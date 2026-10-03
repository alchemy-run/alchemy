import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as el from "@distilled.cloud/azure/extendedlocation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import { AGENT_PUBLIC_KEY_A } from "../HybridKubernetes/fixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const tags = ["provider:azure", "provider:azure:extendedlocation", "live"];

/**
 * A custom location needs a connected Arc Kubernetes cluster (agents
 * running) with a cluster extension installed. Alchemy can register an Arc
 * cluster but cannot run its agents, so the lifecycle test targets an
 * existing cluster + extension supplied through these variables.
 */
const hostResourceId = process.env.AZURE_TEST_CUSTOM_LOCATION_HOST_ID;
const clusterExtensionId =
  process.env.AZURE_TEST_CUSTOM_LOCATION_EXTENSION_ID;
const hostLocation =
  process.env.AZURE_TEST_CUSTOM_LOCATION_REGION ?? "eastus";

const getCustomLocation = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* el.GetCustomLocation({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const customLocationGone = (resourceGroupName: string, resourceName: string) =>
  getCustomLocation(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 36,
    }),
  );

// Ungated probe (free: a resource group plus an ARM-only Arc cluster
// registration whose agents never connect). Without a connected cluster
// the RP cannot read the cluster extension and rejects the custom location.
test.provider(
  "custom location over a disconnected cluster is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const { group, cluster } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const cluster = yield* Azure.HybridKubernetes.ConnectedCluster(
            "Host",
            {
              resourceGroup: group.resourceGroupName,
              agentPublicKeyCertificate: AGENT_PUBLIC_KEY_A,
              distribution: "k3s",
              infrastructure: "generic",
            },
          );
          return { group, cluster };
        }),
      );
      yield* ensureRegistered(subscriptionId, "Microsoft.ExtendedLocation");

      const error = yield* el
        .CustomLocationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          resourceName: "probe",
          location: "eastus",
          properties: {
            hostResourceId: cluster.clusterId,
            hostType: "Kubernetes",
            namespace: "probe",
            clusterExtensionIds: [
              `${cluster.clusterId}/providers/Microsoft.KubernetesConfiguration/extensions/probe`,
            ],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationClusterExtensionNotFound");
      expect(
        yield* customLocationGone(group.resourceGroupName, "probe"),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

const program = (props: {
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: hostLocation,
    });
    const customLocation = yield* Azure.ExtendedLocation.CustomLocation(
      "Site",
      {
        resourceGroup: group.resourceGroupName,
        location: hostLocation,
        hostResourceId: hostResourceId!,
        namespace: "alchemy-test",
        clusterExtensionIds: [clusterExtensionId!],
        displayName: props.displayName,
        tags: props.tags,
      },
    );
    return { group, customLocation };
  });

// Needs a live Arc-connected Kubernetes cluster with a cluster extension
// (AZURE_TEST_PAID=1 plus the AZURE_TEST_CUSTOM_LOCATION_* variables). The
// custom location itself is free; the cluster is whatever it costs to run.
test.provider.skipIf(!runPaidOnly || !hostResourceId || !clusterExtensionId)(
  "create, update, and delete a custom location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, customLocation } = yield* stack.deploy(
        program({ displayName: "Alchemy test", tags: { env: "test" } }),
      );
      expect(customLocation.customLocationName).toMatch(/^[a-z0-9-]{1,63}$/);
      expect(customLocation.provisioningState).toEqual("Succeeded");
      expect(customLocation.tags).toEqual({ env: "test" });
      const observed = yield* getCustomLocation(
        group.resourceGroupName,
        customLocation.customLocationName,
      );
      expect(observed.properties?.namespace).toEqual("alchemy-test");
      expect(observed.properties?.displayName).toEqual("Alchemy test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Site");

      const updated = yield* stack.deploy(
        program({ displayName: "Alchemy test 2", tags: { env: "prod" } }),
      );
      expect(updated.customLocation.customLocationId).toEqual(
        customLocation.customLocationId,
      );
      const reobserved = yield* getCustomLocation(
        group.resourceGroupName,
        customLocation.customLocationName,
      );
      expect(reobserved.properties?.displayName).toEqual("Alchemy test 2");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* customLocationGone(
          group.resourceGroupName,
          customLocation.customLocationName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
