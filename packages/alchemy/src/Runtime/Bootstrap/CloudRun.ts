/**
 * Process bootstrap for `GCP.Run.Service` (and Effect-native Cloud
 * Functions). The generated entry imports this module and the user's
 * `main`, nothing else — see {@link ./Process.ts} for why.
 *
 * Runtime credentials come from the Cloud Run metadata server (the
 * service's runtime SA) so HTTP bindings use least-privilege ADC, not
 * the deploy-time token.
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
import { BunHttpServer } from "../../Http.ts";
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

/** Serve the bundled program with a Bun HTTP server on the injected `PORT`. */
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
        Layer.provideMerge(BunHttpServer({ hostname: "0.0.0.0" })),
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

  return runProcess("Cloud Run service", program);
};
