import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:hybridnetwork", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** AOSM is only available in a few regions. */
export const location = "eastus";

/** Name and version of the ARM-template artifact declared by `withStore`. */
export const template = { name: "tmpl", version: "1.0.0" } as const;

/**
 * A resource group, publisher, container-registry artifact store, and a
 * manifest declaring one ARM-template artifact (never uploaded). The store
 * provisions a Standard ACR in a managed resource group (~1-3 minutes,
 * a few cents per run).
 */
export const withStore = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const publisher = yield* Azure.HybridNetwork.Publisher("Publisher", {
    resourceGroup: group.resourceGroupName,
    location,
  });
  const store = yield* Azure.HybridNetwork.ArtifactStore("Store", {
    resourceGroup: group.resourceGroupName,
    publisher: publisher.publisherName,
    location,
  });
  const manifest = yield* Azure.HybridNetwork.ArtifactManifest("Manifest", {
    resourceGroup: group.resourceGroupName,
    publisher: publisher.publisherName,
    artifactStore: store.artifactStoreName,
    location,
    artifacts: [
      {
        artifactName: template.name,
        artifactType: "ArmTemplate",
        artifactVersion: template.version,
      },
    ],
  });
  return { group, publisher, store, manifest };
});
