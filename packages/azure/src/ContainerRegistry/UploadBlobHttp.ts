import * as acr from "@distilled.cloud/azure/containerregistry-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AzureBindings from "../AzureBindings.ts";
import { makeRegistryCompositeBinding, RegistryRole } from "./BindingHttp.ts";
import { UploadBlob, type UploadBlobRequest } from "./UploadBlob.ts";

/** `sha256:<hex>` of `bytes` (Web Crypto: runs on every host). */
const sha256Digest = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).pipe(
    Effect.map(
      (hash) =>
        `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`,
    ),
  );

/**
 * Implementation of {@link UploadBlob} over the distilled
 * `containerregistry-data` data plane (start upload + complete upload).
 * Assigns the custom `AzureContainerRegistryPushRole` on the registry.
 *
 * @layer
 * @provides Azure.ContainerRegistry.UploadBlob
 */
export const UploadBlobHttp = Layer.effect(
  UploadBlob,
  makeRegistryCompositeBinding({
    tag: "Azure.ContainerRegistry.UploadBlob",
    grants: [RegistryRole.Push],
    operations: Effect.gen(function* () {
      // Resolve one at a time (see AzureBindings.withCredentials).
      const start = yield* AzureBindings.withCredentials(acr.ContainerRegistryBlobStartUpload);
      const complete = yield* AzureBindings.withCredentials(
        acr.UploadContainerRegistryBlobComplete,
      );
      return { start, complete };
    }),
    makeCall: ({ start, complete }, endpoint, label) =>
      Effect.fn(label)(function* (request: UploadBlobRequest) {
        const base = yield* endpoint;
        const digest =
          request.digest !== undefined ? request.digest : yield* sha256Digest(request.body);
        const started = yield* start({ endpoint: base, name: request.name });
        const done = yield* complete({
          endpoint: base,
          nextBlobUuidLink: started.location ?? `/v2/${request.name}/blobs/uploads/`,
          digest,
          body: request.body,
        });
        return { digest: done.dockerContentDigest ?? digest, location: done.location };
      }),
  }),
);
