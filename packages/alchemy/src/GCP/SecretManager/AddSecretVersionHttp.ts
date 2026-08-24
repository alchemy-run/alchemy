import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AddSecretVersion,
  type AddSecretVersionRequest,
} from "./AddSecretVersion.ts";
import type { Secret } from "./Secret.ts";

/**
 * HTTP implementation of {@link AddSecretVersion}.
 *
 * @layer
 * @provides GCP.SecretManager.AddSecretVersion
 */
export const AddSecretVersionHttp = Layer.effect(
  AddSecretVersion,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <S extends Secret>(secret: S) {
      const name = yield* secret.name;
      return Effect.fn(
        `GCP.SecretManager.AddSecretVersion(${secret.LogicalId})`,
      )(function* (request: AddSecretVersionRequest) {
        return yield* secretmanager
          .addVersionProjectsSecrets({
            parent: yield* name,
            body: { payload: request.payload },
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
