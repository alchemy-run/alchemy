import type {
  AppSecret,
  SecretGetError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Secret } from "./Secret.ts";

/**
 * Fetch one Fly.io App secret. The App and name are fixed by
 * `GetSecret(secret)`; calls take no `app_name`. Provide
 * {@link GetSecretHttp} on the Action / Service Effect.
 *
 * Plaintext (`value`) is only returned from inside a Machine in the
 * same App. Deploy-time Actions get metadata (name, digest,
 * timestamps).
 *
 * @binding
 *
 * @section Reading a secret
 * @example Get a bound Secret
 * ```typescript
 * const get = yield* Fly.GetSecret(dbUrl);
 * const got = yield* get();
 * ```
 */
export interface GetSecret extends Binding.Service<
  GetSecret,
  "Fly.GetSecret",
  (
    secret: Secret,
  ) => Effect.Effect<
    () => Effect.Effect<AppSecret, SecretGetError, RuntimeContext>
  >
> {}

export const GetSecret = Binding.Service<GetSecret>("Fly.GetSecret");
