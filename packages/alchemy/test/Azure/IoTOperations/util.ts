import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

/*
 * Azure IoT Operations runs on an Azure Arc-enabled Kubernetes cluster
 * (>= 4 vCPU / 16 GB) with the IoT Operations, secret store, and
 * cert-manager extensions, a custom location, and an Azure Device Registry
 * schema registry. The free trial's ~4 regional vCPUs cannot host that
 * next to anything else, and bring-up takes 20-40 minutes, so every
 * lifecycle test is gated behind AZURE_TEST_PAID=1 plus:
 *
 *   AZURE_TEST_IOT_OPERATIONS_CUSTOM_LOCATION  custom location ARM ID
 *   AZURE_TEST_IOT_OPERATIONS_SCHEMA_REGISTRY  schema registry ARM ID
 *   AZURE_TEST_IOT_OPERATIONS_LOCATION         region (default eastus)
 *
 * A cluster hosts one IoT Operations instance, and each lifecycle test
 * deploys its own, so run the directory with `--concurrency 1`.
 */

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:iotoperations", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

export const location = () =>
  process.env.AZURE_TEST_IOT_OPERATIONS_LOCATION ?? "eastus";

export const customLocationId = () =>
  process.env.AZURE_TEST_IOT_OPERATIONS_CUSTOM_LOCATION ?? "";

export const schemaRegistryId = () =>
  process.env.AZURE_TEST_IOT_OPERATIONS_SCHEMA_REGISTRY ?? "";

/** ARM ID of a custom location that does not exist (probes). */
export const missingCustomLocation = (
  subscriptionId: string,
  resourceGroupName: string,
) => ({
  type: "CustomLocation",
  name: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`,
});

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

/** Resource group + IoT Operations instance for child lifecycle tests. */
export const instanceStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: location(),
  });
  const instance = yield* Azure.IoTOperations.Instance("Instance", {
    resourceGroup: group.resourceGroupName,
    location: location(),
    customLocationId: customLocationId(),
    schemaRegistryId: schemaRegistryId(),
  });
  return { group, instance };
});

/** A bare resource group for the ungated probes. */
export const probeGroup = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  return { group };
});
