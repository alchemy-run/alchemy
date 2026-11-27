import { Credentials, CredentialsFromEnv } from "@distilled.cloud/fly-io";
import { lazyCredentials, orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FLY_AUTH_PROVIDER_NAME, type FlyResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_API_BASE_URL,
  normalizeApiBaseUrl,
  type Config as CredentialsConfig,
} from "@distilled.cloud/fly-io";

/**
 * Capture the deployment's org token as a named runtime Output.
 * Resolve it during binding initialization so plan/diff retains
 * profile-backed credentials rather than falling back to process env.
 */
export const bindFlyApiToken = (): Effect.Effect<void, never, Credentials> =>
  Effect.gen(function* () {
    // Bound as Redacted so a Service that owns its App stores the token
    // as an App secret, not plain Machine env. The runtime reads it back
    // with `CredentialsFromEnv`.
    const token = globalThis.__ALCHEMY_RUNTIME__
      ? Redacted.make("")
      : yield* Credentials.pipe(
          Effect.flatMap((resolve) => resolve),
          Effect.map((cfg) => cfg.apiKey),
          // Binding initialization cannot fail; the engine reports this
          // defect as `CredentialsRequired`.
          orDieCredentialsUnavailable("Fly"),
        );
    yield* Output.named(Output.literal(token), "FLY_API_TOKEN").asEffect().pipe(Effect.asVoid);
  });

/**
 * `Credentials` for the HTTP binding layers (`GetSecretHttp`, `ExecHttp`, …).
 *
 * Those layers are built in two places. Inside a stack (plan/deploy, or an
 * Action) `providers()` has already resolved the profile-backed
 * `Credentials`, and the binding must use them — a laptop deploy has no
 * `FLY_API_TOKEN` in its env once the token lives in the Alchemy profile.
 * Inside a deployed Machine there is no profile; `bindFlyApiToken`
 * has already `RuntimeContext.set` the org token, which reaches the
 * Machine as `FLY_API_TOKEN` (an App secret, or Machine env in a shared
 * App). So: reuse the ambient `Credentials` when present, otherwise read
 * it with {@link CredentialsFromEnv}.
 */
export const CredentialsFromAmbientOrEnv: Layer.Layer<Credentials> = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const ambient = yield* Effect.serviceOption(Credentials);
    if (Option.isSome(ambient)) return ambient.value;
    // In a Machine without `FLY_API_TOKEN` the env layer fails when it is
    // built; this layer is typed as never failing, so that dies.
    return yield* Credentials.pipe(Effect.provide(Layer.orDie(CredentialsFromEnv)));
  }),
);

/**
 * Build a `Credentials` layer that resolves Fly credentials via the current
 * Alchemy profile, or directly from environment variables in CI.
 *
 * Maps onto `@distilled.cloud/fly-io`'s `{ apiKey, apiBaseUrl }` shape.
 * Distilled's own `CredentialsFromEnv` also accepts `FLY_IO_API_KEY` as a
 * fallback — Alchemy itself only reads `FLY_API_TOKEN`.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    // `Credentials` has no error channel: a failed resolution dies, and the
    // engine reports it as `CredentialsRequired`.
    lazyCredentials<FlyResolvedCredentials>()(FLY_AUTH_PROVIDER_NAME, (creds) => ({
      apiKey: creds.apiKey,
      apiBaseUrl: creds.apiBaseUrl,
    })).pipe(Effect.map(Effect.orDie)),
  );
