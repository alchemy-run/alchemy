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
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "./Process.ts";

const metadataCredentials = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.gen(function* () {
      const response = yield* http.execute(
        HttpClientRequest.get(
          "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        ).pipe(HttpClientRequest.setHeader("Metadata-Flavor", "Google")),
      );
      if (response.status !== 200) {
        return yield* Effect.fail(
          new Error(`metadata token HTTP ${response.status}`),
        );
      }
      const body = yield* response.json;
      const token =
        typeof body === "object" &&
        body !== null &&
        "access_token" in body &&
        typeof body.access_token === "string"
          ? body.access_token
          : undefined;
      if (token === undefined) {
        return yield* Effect.fail(
          new Error("metadata token response missing access_token"),
        );
      }
      const project = yield* Effect.sync(
        () => process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT,
      );
      return {
        accessToken: Redacted.make(token),
        project,
      };
    }).pipe(Effect.orDie);
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

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
