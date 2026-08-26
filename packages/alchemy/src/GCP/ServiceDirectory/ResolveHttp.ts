import * as servicedirectory from "@distilled.cloud/gcp/servicedirectory_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Resolve, type ResolveRequest } from "./Resolve.ts";
import type { Service } from "./Service.ts";

/**
 * HTTP implementation of {@link Resolve}.
 *
 * @layer
 * @provides GCP.ServiceDirectory.Resolve
 */
export const ResolveHttp = Layer.effect(
  Resolve,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <S extends Service>(service: S) {
      const name = yield* service.name;
      return Effect.fn(`GCP.ServiceDirectory.Resolve(${service.LogicalId})`)(
        function* (request?: ResolveRequest) {
          return yield* servicedirectory
            .resolveProjectsLocationsNamespacesServices({
              ...request,
              name: yield* name,
            })
            .pipe(
              Effect.provideService(Credentials, credentials),
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );
        },
      );
    });
  }),
);
