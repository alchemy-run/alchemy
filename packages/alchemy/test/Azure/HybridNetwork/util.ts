import * as Azure from "@/Azure";
import type { Input } from "@/Input";
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

/** Name and version of the VHD artifact declared by `withVhdStore`. */
export const vhd = { name: "image-vhd", version: "1-0-0" } as const;

/**
 * A storage-account artifact store plus a manifest declaring one VHD image
 * artifact. AOSM requires a VHD application in every Azure Core VNF.
 */
export const withVhdStore = (props: {
  resourceGroup: Input<string>;
  publisher: Input<string>;
}) =>
  Effect.gen(function* () {
    const vhdStore = yield* Azure.HybridNetwork.ArtifactStore("VhdStore", {
      resourceGroup: props.resourceGroup,
      publisher: props.publisher,
      location,
      storeType: "AzureStorageAccount",
    });
    const vhdManifest = yield* Azure.HybridNetwork.ArtifactManifest(
      "VhdManifest",
      {
        resourceGroup: props.resourceGroup,
        publisher: props.publisher,
        artifactStore: vhdStore.artifactStoreName,
        location,
        artifacts: [
          {
            artifactName: vhd.name,
            artifactType: "VhdImageFile",
            artifactVersion: vhd.version,
          },
        ],
      },
    );
    return { vhdStore, vhdManifest };
  });

/** 1 GiB: the smallest whole-GiB disk; the page blob stays sparse. */
const VHD_SIZE = 1024 * 1024 * 1024;

/** The 512-byte footer of a fixed VHD of `size` bytes (VHD spec v1.0). */
const vhdFooter = (size: number) => {
  const footer = new Uint8Array(512);
  const view = new DataView(footer.buffer);
  const ascii = (offset: number, text: string) =>
    footer.set(new TextEncoder().encode(text), offset);
  ascii(0, "conectix");
  view.setUint32(8, 2);
  view.setUint32(12, 0x00010000);
  view.setBigUint64(16, 0xffffffffffffffffn);
  ascii(28, "alch");
  view.setUint32(32, 0x00010000);
  ascii(36, "Wi2k");
  view.setBigUint64(40, BigInt(size));
  view.setBigUint64(48, BigInt(size));
  const total = Math.min(size / 512, 65535 * 16 * 255);
  let spt: number;
  let heads: number;
  let cth: number;
  if (total >= 65535 * 16 * 63) {
    spt = 255;
    heads = 16;
    cth = Math.floor(total / spt);
  } else {
    spt = 17;
    cth = Math.floor(total / spt);
    heads = Math.max(4, Math.floor((cth + 1023) / 1024));
    if (cth >= heads * 1024 || heads > 16) {
      spt = 31;
      heads = 16;
      cth = Math.floor(total / spt);
    }
    if (cth >= heads * 1024) {
      spt = 63;
      heads = 16;
      cth = Math.floor(total / spt);
    }
  }
  view.setUint16(56, Math.floor(cth / heads));
  view.setUint8(58, heads);
  view.setUint8(59, spt);
  view.setUint32(60, 2);
  footer.set(new TextEncoder().encode("alchemy-aosm-vhd"), 68);
  let sum = 0;
  for (const byte of footer) sum += byte;
  view.setUint32(64, ~sum >>> 0);
  return footer;
};

/**
 * Upload an empty fixed VHD as the manifest's VHD artifact (what
 * `az aosm nfd publish` does: a page blob named `<name>-<version>.vhd` in
 * the manifest's container). Storage-account manifests have no `Uploaded`
 * state to set; re-uploading is idempotent.
 */
export const uploadVhd = (where: {
  resourceGroupName: string;
  publisherName: string;
  artifactStoreName: string;
  artifactManifestName: string;
}) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const base = { subscriptionId, ...where };
    const cred = yield* hybridnetwork.ListArtifactManifestCredential(base);
    const sas = cred.containerCredentials?.[0]?.containerSasUri;
    const sasUri =
      sas === undefined ? "" : Redacted.isRedacted(sas) ? Redacted.value(sas) : sas;
    const [prefix, token] = sasUri.split("?", 2);
    const blobUrl = `${prefix}/${vhd.name.slice(0, -4).replaceAll("-", "")}-${vhd.version}.vhd?${token}`;
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    );
    const storage = HttpClientRequest.setHeader("x-ms-version", "2021-08-06");
    yield* client.execute(
      HttpClientRequest.put(blobUrl).pipe(
        storage,
        HttpClientRequest.setHeader("x-ms-blob-type", "PageBlob"),
        HttpClientRequest.setHeader(
          "x-ms-blob-content-length",
          String(VHD_SIZE + 512),
        ),
      ),
    );
    yield* client.execute(
      HttpClientRequest.put(`${blobUrl}&comp=page`).pipe(
        storage,
        HttpClientRequest.setHeader("x-ms-page-write", "update"),
        HttpClientRequest.setHeader(
          "x-ms-range",
          `bytes=${VHD_SIZE}-${VHD_SIZE + 511}`,
        ),
        HttpClientRequest.bodyUint8Array(
          vhdFooter(VHD_SIZE),
          "application/octet-stream",
        ),
      ),
    );
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
