import { Credentials } from "@distilled.cloud/axiom/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AXIOM_AUTH_PROVIDER_NAME, type AxiomResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/axiom/Credentials";

/**
 * Build a `Credentials` layer that resolves Axiom credentials via the Alchemy
 * AuthProvider using the configured profile (defaults to "default", overridable
 * with the current Alchemy profile).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<AxiomResolvedCredentials>()(AXIOM_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiToken,
      apiBaseUrl: creds.apiBaseUrl,
      orgId: creds.orgId,
    })).pipe(Effect.map(Effect.orDie)),
  );

/**
 * The credentials {@link providers} use: a `Credentials` provided from
 * outside wins, otherwise {@link fromAuthProvider}. Deploy with another
 * token with `Axiom.providers().pipe(Layer.provide(credentials))`.
 */
export const providedOrDefault = () =>
  // A fresh layer per call: layers are memoized by identity, so a shared
  // instance built once with nothing provided would shadow a provided one.
  Credentials.pipe(
    Effect.serviceOption,
    Effect.map((provided) =>
      Option.isSome(provided) ? Layer.succeed(Credentials, provided.value) : fromAuthProvider(),
    ),
    Layer.unwrap,
  );
