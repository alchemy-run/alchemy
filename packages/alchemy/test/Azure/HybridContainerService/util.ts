import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as hybridkubernetes from "@distilled.cloud/azure/hybridkubernetes";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = [
  "provider:azure",
  "provider:azure:hybridcontainerservice",
  "live",
];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Region of the Azure Local custom location (paid-only tests). */
export const hciLocation = () =>
  process.env.AZURE_TEST_HCI_LOCATION ?? "eastus";

/** Arc custom location of an Azure Local cluster (paid-only tests). */
export const customLocationId = () =>
  process.env.AZURE_TEST_HCI_CUSTOM_LOCATION ?? "";

/**
 * Infrastructure network (Azure Local logical network ID) AKS Arc nodes
 * attach to (paid-only tests).
 */
export const logicalNetworkId = () =>
  process.env.AZURE_TEST_AKSARC_LOGICAL_NETWORK ?? "";

/** ARM ID of a custom location that does not exist (probes). */
export const missingCustomLocation = (
  subscriptionId: string,
  resourceGroupName: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`;

/** Throwaway RSA public key (fixture; the private half was discarded). */
export const sshPublicKey =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCWlgQ1nXOCGDeom+GlYNReAaRYarKaWnp6sUT38mdiqnaet5B9Et0RcK3a6pSgOPw4dTZzncK5RNCYoaWLuZJdN81P+mnpzsZBBpzE4dj8PVwsHhtfJ4Bgyk9dZIWM0X4izWZ2Hf3hRmL00ErQ2nHRi+3vMvK9inDr4fnHecI8tW6hV7Gqm8xG9O+DevPVCCuPEA2xbI9p9V1avEKjTGvfy18Te4kbLUlFeUwMEAKGJ61u9qraam/yMCdkicaOhIQ0ZJ/smVW3jykQ557txJ+1BvFZ5dWRyACyee9ycsSrMHiyF0udcx6Qc20eeFBMG0q1wNx9Ro8J7GFOwzPIbsPp alchemy-test";

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

/**
 * Create an Arc connected cluster record of kind `ProvisionedCluster`
 * (`Microsoft.Kubernetes/connectedClusters`, free; no agent ever connects)
 * out of band, run `use` with its ID, and delete it afterwards. AKS Arc
 * clusters are extension resources of such a record.
 */
export const withConnectedCluster = <A, E, R>(
  resourceGroupName: string,
  location: string,
  use: (connectedClusterId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    yield* ensureRegistered(subscriptionId, "Microsoft.Kubernetes");
    const where = { subscriptionId, resourceGroupName, clusterName: "aksarc" };
    return yield* Effect.acquireUseRelease(
      hybridkubernetes.ConnectedClusterCreateOrReplace({
        ...where,
        location,
        kind: "ProvisionedCluster",
        identity: { type: "SystemAssigned" },
        properties: { agentPublicKeyCertificate: "" },
      }),
      (cluster) => use(cluster.id ?? ""),
      () =>
        hybridkubernetes
          .DeleteConnectedCluster(where)
          .pipe(
            Effect.ignore,
            Effect.andThen(
              waitGone(hybridkubernetes.GetConnectedCluster(where)).pipe(
                Effect.ignore,
              ),
            ),
          ),
    );
  });
