import { CredentialsUnavailable, lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  DEFAULT_API_BASE_URL,
  RENDER_AUTH_PROVIDER_NAME,
  type RenderResolvedCredentials,
} from "./AuthProvider.ts";

export { DEFAULT_API_BASE_URL } from "./AuthProvider.ts";

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

export interface RenderClientConfig {
  readonly apiKey: Redacted.Redacted<string>;
  readonly ownerId?: string;
  readonly apiBaseUrl: string;
}

/**
 * Lazy credentials handle for Render REST API v1 calls. Resolved on each API
 * request rather than eagerly in layer construction so `alchemy plan` / dry
 * contexts without credentials still compose cleanly.
 */
export class RenderCredentials extends Context.Service<
  RenderCredentials,
  Effect.Effect<RenderClientConfig, CredentialsUnavailable>
>()("Render.Credentials") {}

/**
 * Build a {@link RenderCredentials} layer backed by Alchemy's profile/CI
 * AuthProvider (`RenderAuth`).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    RenderCredentials,
    lazyCredentials<RenderResolvedCredentials, CredentialsUnavailable>()(
      RENDER_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.apiKey,
        ownerId: creds.ownerId,
        apiBaseUrl: creds.apiBaseUrl,
      }),
    ),
  );

/**
 * Build an explicit {@link RenderCredentials} layer for programmatic or local
 * emulator setups (e.g. pointing at a mock `apiBaseUrl`).
 */
export const fromConfig = (config: {
  readonly apiKey: string | Redacted.Redacted<string>;
  readonly ownerId?: string;
  readonly apiBaseUrl?: string;
}) =>
  Layer.succeed(
    RenderCredentials,
    Effect.succeed({
      apiKey: typeof config.apiKey === "string" ? Redacted.make(config.apiKey) : config.apiKey,
      ownerId: config.ownerId,
      apiBaseUrl: (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    }),
  );
