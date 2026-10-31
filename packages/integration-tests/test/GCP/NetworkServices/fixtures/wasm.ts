import * as GCP from "@alchemy.run/gcp";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/** The smallest valid Wasm module (magic number + version). */
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

class WasmUploadFailed extends Data.TaggedError("WasmUploadFailed")<{
  status: number;
  body: string;
}> {}

/** Generic Artifact Registry repository the plugin image lives in. */
export const WasmArtifacts = GCP.ArtifactRegistry.Repository("WasmArtifacts", {
  location: "us-central1",
  format: "GENERIC",
  description: "wasm plugin artifacts",
});

/** Image URI of the uploaded plugin in {@link WasmArtifacts}. */
export const pluginImageUri = (repository: GCP.ArtifactRegistry.Repository) =>
  Output.interpolate`${repository.name}/genericArtifacts/plugin:v1`;

/**
 * Upload the plugin binary as a generic artifact (Artifact Registry has no
 * resource for artifact contents). A repeat upload answers 409, which counts
 * as done.
 */
export const uploadPluginWasm = (repositoryName: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const url =
      `https://artifactregistry.googleapis.com/upload/v1/${repositoryName}/genericArtifacts:create` +
      `?uploadType=media&filename=plugin.wasm&packageId=plugin&versionId=v1`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(creds.accessToken)}`),
        HttpClientRequest.bodyUint8Array(WASM, "application/octet-stream"),
      ),
    );
    if (response.status === 409) return;
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
      return yield* new WasmUploadFailed({ status: response.status, body });
    }
  }).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("2 seconds") }));
