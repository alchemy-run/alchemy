import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AccessSecretVersion,
  type AccessSecretVersionRequest,
} from "./AccessSecretVersion.ts";
import type { Secret } from "./Secret.ts";

/**
 * HTTP implementation of {@link AccessSecretVersion}.
 *
 * @layer
 * @provides GCP.SecretManager.AccessSecretVersion
 */
export const AccessSecretVersionHttp = Layer.effect(
  AccessSecretVersion,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* <S extends Secret>(secret: S) {
      const name = yield* secret.name;
      return Effect.fn(
        `GCP.SecretManager.AccessSecretVersion(${secret.LogicalId})`,
      )(function* (request?: AccessSecretVersionRequest) {
        const version = request?.version ?? "latest";
        return yield* secretmanager
          .accessProjectsSecretsVersions({
            name: `${yield* name}/versions/${version}`,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
