import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetParameter } from "./GetParameter.ts";
import type { Parameter } from "./Parameter.ts";

/**
 * HTTP implementation of {@link GetParameter}.
 *
 * @layer
 * @provides GCP.Parametermanager.GetParameter
 */
export const GetParameterHttp = Layer.effect(
  GetParameter,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const getParameter =
      yield* parametermanager.getProjectsLocationsParameters.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    return Effect.fn(function* (parameter: Parameter) {
      const name = yield* parameter.name;
      return Effect.fn(
        `GCP.Parametermanager.GetParameter(${parameter.LogicalId})`,
      )(function* () {
        return yield* getParameter({ name: yield* name });
      });
    });
  }),
);
