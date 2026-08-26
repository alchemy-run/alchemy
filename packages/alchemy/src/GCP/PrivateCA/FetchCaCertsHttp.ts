import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as privateca from "@distilled.cloud/gcp/privateca_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { CaPool } from "./CaPool.ts";
import { FetchCaCerts, type FetchCaCertsRequest } from "./FetchCaCerts.ts";

/**
 * HTTP implementation of {@link FetchCaCerts}.
 *
 * @layer
 * @provides GCP.PrivateCA.FetchCaCerts
 */
export const FetchCaCertsHttp = Layer.effect(
  FetchCaCerts,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <P extends CaPool>(pool: P) {
      const name = yield* pool.name;
      return Effect.fn(`GCP.PrivateCA.FetchCaCerts(${pool.LogicalId})`)(
        function* (request?: FetchCaCertsRequest) {
          return yield* privateca
            .fetchCaCertsProjectsLocationsCaPools({
              caPool: yield* name,
              body:
                request?.requestId !== undefined
                  ? { requestId: request.requestId }
                  : {},
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
