import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { ParametersVersion } from "./ParametersVersion.ts";
import { RenderParameterVersion } from "./RenderParameterVersion.ts";

/**
 * HTTP implementation of {@link RenderParameterVersion}.
 *
 * @layer
 * @provides GCP.Parametermanager.RenderParameterVersion
 */
export const RenderParameterVersionHttp = Layer.effect(
  RenderParameterVersion,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const render =
      yield* parametermanager.renderProjectsLocationsParametersVersions.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    return Effect.fn(function* (version: ParametersVersion) {
      const name = yield* version.name;
      return Effect.fn(
        `GCP.Parametermanager.RenderParameterVersion(${version.LogicalId})`,
      )(function* () {
        return yield* render({ name: yield* name });
      });
    });
  }),
);
