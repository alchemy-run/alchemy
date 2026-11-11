import * as secrets from "@distilled.cloud/e2b/secrets";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CreateSecret, type SecretsClient } from "./CreateSecret.ts";
import { bindE2B, bindOwnerTags } from "./E2BBindings.ts";
import { E2BUnexpectedResponse } from "./Errors.ts";
import { toSecretAttributes } from "./Secret.ts";

/**
 * HTTP implementation of {@link CreateSecret}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const secrets = yield* E2B.CreateSecret();
 *   // ...
 * }).pipe(Effect.provide(E2B.CreateSecretHttp))
 * ```
 *
 * @layer
 * @product Secret
 * @provides E2B.CreateSecret
 */
export const CreateSecretHttp = Layer.effect(
  CreateSecret,
  Effect.gen(function* () {
    return Effect.fn("E2B.CreateSecret")(function* () {
      const auth = yield* bindE2B;
      const owner = yield* bindOwnerTags;

      const get = (nameOrId: string) =>
        auth.authorize(secrets.getSecret({ secretID: nameOrId.toLowerCase() })).pipe(
          Effect.map((secret): secrets.Secret | undefined => secret),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      const client: SecretsClient = {
        put: Effect.fn("E2B.CreateSecret.put")(function* (name, value, putOptions) {
          const metadata = { ...putOptions?.metadata, ...(yield* owner) };
          const existing = yield* get(name);
          const stored =
            existing !== undefined
              ? yield* auth.authorize(
                  secrets.updateSecret({ secretID: existing.secretID, value, metadata }),
                )
              : yield* auth.authorize(secrets.createSecret({ name, value, metadata })).pipe(
                  // A concurrent put created it first: add our version.
                  Effect.catchTag("Conflict", () =>
                    Effect.gen(function* () {
                      const raced = yield* get(name);
                      if (raced === undefined) {
                        return yield* new E2BUnexpectedResponse({
                          message: `E2B secret ${name} vanished during put`,
                        });
                      }
                      return yield* auth.authorize(
                        secrets.updateSecret({ secretID: raced.secretID, value, metadata }),
                      );
                    }),
                  ),
                );
          return toSecretAttributes(stored);
        }),
        get: (nameOrId) =>
          get(nameOrId).pipe(
            Effect.map((secret) => (secret === undefined ? undefined : toSecretAttributes(secret))),
          ),
        list: Effect.fn("E2B.CreateSecret.list")(function* () {
          const owned = yield* owner;
          const all = yield* auth.authorize(
            Stream.runCollect(secrets.listSecrets.items({ limit: 100 })),
          );
          return Array.from(all)
            .filter((secret) =>
              Object.entries(owned).every(([key, value]) => secret.metadata[key] === value),
            )
            .map(toSecretAttributes);
        }),
        delete: (nameOrId) =>
          Effect.flatMap(get(nameOrId), (secret) =>
            secret === undefined
              ? Effect.void
              : auth.authorize(secrets.deleteSecret({ secretID: secret.secretID })).pipe(
                  Effect.asVoid,
                  Effect.catchTag("NotFound", () => Effect.void),
                ),
          ),
      };
      return client;
    });
  }),
);
