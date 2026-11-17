import * as secrets from "@distilled.cloud/e2b/secrets";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindE2B } from "./E2BBindings.ts";
import { type Secret, toSecretAttributes } from "./Secret.ts";
import { WriteSecret, type WriteSecretClient } from "./WriteSecret.ts";

/**
 * HTTP implementation of {@link WriteSecret}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const token = yield* E2B.WriteSecret(GitHubToken);
 *   // ...
 * }).pipe(Effect.provide(E2B.WriteSecretHttp))
 * ```
 *
 * @layer
 * @product Secret
 * @provides E2B.WriteSecret
 */
export const WriteSecretHttp = Layer.succeed(
  WriteSecret,
  Effect.fn("E2B.WriteSecret")(function* (secret: Secret) {
    const auth = yield* bindE2B;
    const secretId = yield* (secret.secretId as Output.Output<string, never>).asEffect();
    const client: WriteSecretClient = {
      put: Effect.fn("E2B.WriteSecret.put")(function* (value) {
        const id = yield* secretId;
        // Keep the secret's metadata (ownership stamp included) as it is.
        const current = yield* auth.authorize(secrets.getSecret({ secretID: id }));
        const stored = yield* auth.authorize(
          secrets.updateSecret({ secretID: id, value, metadata: current.metadata }),
        );
        return toSecretAttributes(stored);
      }),
    };
    return client;
  }),
);
