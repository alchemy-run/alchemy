import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * Base URL of Sentry's SaaS API. Self-hosted instances expose the same
 * `/api/0` surface under their own host.
 */
export const DEFAULT_API_BASE_URL = "https://sentry.io/api/0";

export type CredentialsValue = {
  /** Auth token used as `Authorization: Bearer <token>`. */
  readonly authToken: Redacted.Redacted<string>;
  /** API root, e.g. `https://sentry.example.com/api/0` for self-hosted. */
  readonly apiBaseUrl: string;
};

/**
 * Sentry credentials. Resolved once per stack and shared by every Sentry
 * provider.
 */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<CredentialsValue>
>()("alchemy/Sentry/Credentials") {}

/**
 * Build a `Credentials` layer from an explicit token.
 *
 * @example
 * ```ts
 * Effect.provide(
 *   Sentry.fromToken({
 *     authToken: process.env.SENTRY_AUTH_TOKEN!,
 *     apiBaseUrl: "https://sentry.example.com/api/0",
 *   }),
 * )
 * ```
 */
export const fromToken = (input: {
  authToken: string | Redacted.Redacted<string>;
  apiBaseUrl?: string;
}) =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      authToken:
        typeof input.authToken === "string"
          ? Redacted.make(input.authToken)
          : input.authToken,
      apiBaseUrl: input.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    }),
  );

/**
 * Build a `Credentials` layer from the environment.
 *
 * Reads `SENTRY_AUTH_TOKEN` and, for self-hosted instances,
 * `SENTRY_API_BASE_URL` (defaults to `https://sentry.io/api/0`).
 */
export const fromEnv = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const authToken = yield* Config.redacted("SENTRY_AUTH_TOKEN");
      const apiBaseUrl = yield* Config.string("SENTRY_API_BASE_URL").pipe(
        Config.withDefault(DEFAULT_API_BASE_URL),
      );
      return Effect.succeed({
        authToken,
        apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
      });
    }),
  );
