import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/*
 * A Container Apps connected environment runs on an Azure Arc-enabled
 * Kubernetes cluster with the Container Apps extension and an Arc custom
 * location. That is an external system the testing subscription does not
 * host, so the connected-environment lifecycles run only with
 * AZURE_TEST_PAID=1 plus:
 *
 *   AZURE_TEST_CONTAINERAPPS_CUSTOM_LOCATION  custom location ARM ID
 *   AZURE_TEST_CONTAINERAPPS_ARC_LOCATION     region of the cluster (default eastus)
 *
 * Each file keeps an ungated probe that asserts the typed error Azure
 * returns without that infrastructure.
 */

export const arcLocation = () => process.env.AZURE_TEST_CONTAINERAPPS_ARC_LOCATION ?? "eastus";

export const customLocationId = () => process.env.AZURE_TEST_CONTAINERAPPS_CUSTOM_LOCATION ?? "";

/** ARM ID of a custom location that does not exist (probes). */
export const missingCustomLocationId = (subscriptionId: string, resourceGroupName: string) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`;

/** Name of a connected environment that does not exist (probes). */
export const MISSING_ENVIRONMENT = "alchemy-missing-arc-env";

/** A bare resource group for the ungated probes. */
export const probeGroup = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  return { group };
});

/** Resource group + connected environment for the gated lifecycles. */
export const connectedEnvironmentStack = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: arcLocation(),
  });
  const env = yield* Azure.ContainerApps.ConnectedEnvironment("ArcEnv", {
    resourceGroup: group.resourceGroupName,
    location: arcLocation(),
    customLocationId: customLocationId(),
  });
  return { group, env };
});
