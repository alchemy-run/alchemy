import type { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/render";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RENDER_AUTH_PROVIDER_NAME, type RenderResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  fromApiKey,
  type Config as RenderClientConfig,
} from "@distilled.cloud/render";

export interface PollConfig {
  readonly intervalMs: number;
  readonly maxAttempts: number;
}

/**
 * Optional polling configuration service used primarily by local test suites
 * to override retry intervals between async readiness checks. Accessed via
 * `Effect.serviceOption` so it never leaks into `Providers` requirements.
 */
export class RenderPollConfig extends Context.Service<RenderPollConfig, PollConfig>()(
  "Render.PollConfig",
) {}

/**
 * Optional default Render workspace/owner ID (`tea-...` / `usr-...`) resolved
 * from {@link ownerId}, stored Alchemy profile config, or `RENDER_OWNER_ID`.
 */
export class OwnerId extends Context.Service<OwnerId, Effect.Effect<string | undefined>>()(
  "Render.OwnerId",
) {}

/**
 * Provide an explicit Render workspace/owner ID layer (matching `AWS.Region`).
 */
export const ownerId = (id: string): Layer.Layer<OwnerId> =>
  Layer.succeed(OwnerId, Effect.succeed(id));

/**
 * Build a {@link Credentials} layer backed by Alchemy's profile/CI
 * AuthProvider (`RenderAuth`).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    // `Credentials` reports missing auth as `CredentialsUnavailable` (surfaced by
    // the engine as `CredentialsRequired`) rather than failing with `ConfigError`.
    lazyCredentials<RenderResolvedCredentials, ConfigError>()(
      RENDER_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.apiKey,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ).pipe(Effect.map(Effect.orDie)),
  );

/**
 * Build an {@link OwnerId} layer reading the optional `ownerId` configured on
 * the active Alchemy profile or `RENDER_OWNER_ID`.
 */
export const ownerIdFromAuthProvider = () =>
  Layer.effect(
    OwnerId,
    lazyCredentials<RenderResolvedCredentials>()(
      RENDER_AUTH_PROVIDER_NAME,
      (creds) => creds.ownerId,
    ).pipe(Effect.map(Effect.orDie)),
  );

/**
 * Use an externally provided {@link Credentials} layer when present, otherwise
 * fall back to {@link fromAuthProvider}.
 */
export const providedOrDefault = () =>
  Credentials.pipe(
    Effect.serviceOption,
    Effect.map((provided) =>
      Option.isSome(provided) ? Layer.succeed(Credentials, provided.value) : fromAuthProvider(),
    ),
    Layer.unwrap,
  );

/**
 * Use an externally provided {@link OwnerId} layer when present, otherwise
 * fall back to {@link ownerIdFromAuthProvider}.
 */
export const ownerIdProvidedOrDefault = () =>
  OwnerId.pipe(
    Effect.serviceOption,
    Effect.map((provided) =>
      Option.isSome(provided) ? Layer.succeed(OwnerId, provided.value) : ownerIdFromAuthProvider(),
    ),
    Layer.unwrap,
  );
