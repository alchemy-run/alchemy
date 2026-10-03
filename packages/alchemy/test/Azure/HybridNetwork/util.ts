import * as Azure from "@/Azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
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

/** An ARM template that deploys nothing; enough for AOSM to run a deployment. */
export const emptyArmTemplate = JSON.stringify({
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {},
  resources: [],
});

const sha256 = (bytes: Uint8Array) =>
  Effect.sync(() => `sha256:${createHash("sha256").update(bytes).digest("hex")}`);

/**
 * Push `emptyArmTemplate` to the store's registry as the manifest's
 * ARM-template artifact (what `oras push` / `az aosm publish` do) and mark
 * the manifest `Uploaded`.
 */
export const uploadTemplate = (where: {
  resourceGroupName: string;
  publisherName: string;
  artifactStoreName: string;
  artifactManifestName: string;
}) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const base = { subscriptionId, ...where };
    const manifest = yield* hybridnetwork.GetArtifactManifest(base);
    if (manifest.properties?.artifactManifestState === "Uploaded") return;
    const cred = yield* hybridnetwork.ListArtifactManifestCredential(base);
    const server = (cred.acrServerUrl ?? "").replace(/^https?:\/\//, "");
    const repo = template.name;
    const password =
      cred.acrToken === undefined
        ? ""
        : Redacted.isRedacted(cred.acrToken)
          ? Redacted.value(cred.acrToken)
          : cred.acrToken;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    );
    // Exchange the scoped token for a registry access token (docker auth).
    const tokenResponse = yield* client.execute(
      HttpClientRequest.get(`https://${server}/oauth2/token`).pipe(
        HttpClientRequest.setUrlParam("service", server),
        HttpClientRequest.setUrlParam("scope", `repository:${repo}:pull,push`),
        HttpClientRequest.basicAuth(cred.username ?? "", password),
      ),
    );
    const { access_token } = (yield* tokenResponse.json) as {
      access_token: string;
    };
    const auth = HttpClientRequest.bearerToken(access_token);
    const pushBlob = (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const digest = yield* sha256(bytes);
        const start = yield* client.execute(
          HttpClientRequest.post(
            `https://${server}/v2/${repo}/blobs/uploads/`,
          ).pipe(auth),
        );
        const location = start.headers["location"] ?? "";
        const url = location.startsWith("http")
          ? location
          : `https://${server}${location}`;
        yield* client.execute(
          HttpClientRequest.put(
            `${url}${url.includes("?") ? "&" : "?"}digest=${digest}`,
          ).pipe(
            auth,
            HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
          ),
        );
        return { digest, size: bytes.byteLength };
      });
    const layer = yield* pushBlob(new TextEncoder().encode(emptyArmTemplate));
    const config = yield* pushBlob(new TextEncoder().encode("{}"));
    yield* client.execute(
      HttpClientRequest.put(
        `https://${server}/v2/${repo}/manifests/${template.version}`,
      ).pipe(
        auth,
        HttpClientRequest.bodyText(
          JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            config: {
              mediaType: "application/vnd.unknown.config.v1+json",
              ...config,
            },
            layers: [
              {
                mediaType: "application/vnd.oci.image.layer.v1.tar",
                ...layer,
                annotations: {
                  "org.opencontainers.image.title": `${template.name}.json`,
                },
              },
            ],
          }),
          "application/vnd.oci.image.manifest.v1+json",
        ),
      ),
    );
    yield* hybridnetwork.UpdateArtifactManifestState({
      ...base,
      artifactManifestState: "Uploaded",
    });
    yield* hybridnetwork.GetArtifactManifest(base).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (m) => m.properties?.artifactManifestState === "Uploaded",
        times: 36,
      }),
    );
  });
