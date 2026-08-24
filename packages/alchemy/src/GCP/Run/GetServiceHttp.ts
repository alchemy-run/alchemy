import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { GetService, type GetServiceRequest } from "./GetService.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of {@link GetService}.
 *
 * @layer
 * @provides GCP.Run.GetService
 */
export const GetServiceHttp = Layer.effect(
  GetService,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <T extends Service>(service: T) {
      const name = yield* service.name;
      return Effect.fn(`GCP.Run.GetService(${service.LogicalId})`)(function* (
        request?: GetServiceRequest,
      ) {
        return yield* cloudrun
          .getProjectsLocationsServices({
            ...request,
            name: yield* name,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
