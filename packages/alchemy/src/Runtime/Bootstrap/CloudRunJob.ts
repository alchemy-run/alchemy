/**
 * Process bootstrap for `GCP.Run.Job`. No HTTP server — the process
 * exits 0 once the bundled program finishes (Cloud Run waits on the
 * container).
 */
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

const metadataCredentials = Layer.succeed(
  Credentials,
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { headers: { "Metadata-Flavor": "Google" } },
      );
      if (!response.ok) {
        throw new Error(`metadata token HTTP ${response.status}`);
      }
      const body = (await response.json()) as { access_token?: string };
      if (!body.access_token) {
        throw new Error("metadata token response missing access_token");
      }
      return {
        accessToken: Redacted.make(body.access_token),
        project: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT,
      };
    },
    catch: (cause) =>
      new Error("Failed to mint Cloud Run metadata access token", {
        cause,
      }),
  }).pipe(Effect.orDie),
);

export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(metadataCredentials),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Cloud Run job", program, { exitOnComplete: true });
};
