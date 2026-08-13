import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthError, getAuthProvider } from "../Auth/AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "../Auth/Profile.ts";
import {
  DATADOG_AUTH_PROVIDER_NAME,
  type DatadogAuthConfig,
  type DatadogResolvedCredentials,
} from "./AuthProvider.ts";

/** Datadog US1. Other sites: `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com`, `ddog-gov.com`. */
export const DEFAULT_SITE = "datadoghq.com";

/**
 * Resolve a Datadog "site" (e.g. `us5.datadoghq.com`) into the API base URL
 * (`https://api.us5.datadoghq.com`). A value that is already a URL is used
 * verbatim, so a full endpoint override (proxies, testing) also works.
 */
export const siteToApiBaseUrl = (site: string): string =>
  site.startsWith("http://") || site.startsWith("https://")
    ? site.replace(/\/+$/, "")
    : `https://api.${site}`;

export interface DatadogCredentialsService {
  /** The Datadog API key, sent as the `DD-API-KEY` header. */
  readonly apiKey: Redacted.Redacted<string>;
  /**
   * The Datadog application key, sent as the `DD-APPLICATION-KEY` header.
   * Must carry the `monitors_write` / `slos_write` scopes (unscoped keys
   * have full account permissions).
   */
  readonly appKey: Redacted.Redacted<string>;
  /** API base URL, e.g. `https://api.datadoghq.com`. */
  readonly apiBaseUrl: string;
}

/**
 * The Datadog credentials service. The service value is a (lazily resolved)
 * Effect so that interactive/stored credential resolution only happens when
 * a Datadog API call is actually made, not at layer build.
 */
export class Credentials extends Context.Service<
  Credentials,
  Effect.Effect<DatadogCredentialsService>
>()("Datadog::Credentials") {}

const make = (
  apiKey: string | Redacted.Redacted<string>,
  appKey: string | Redacted.Redacted<string>,
  site?: string,
): DatadogCredentialsService => ({
  apiKey: typeof apiKey === "string" ? Redacted.make(apiKey) : apiKey,
  appKey: typeof appKey === "string" ? Redacted.make(appKey) : appKey,
  apiBaseUrl: siteToApiBaseUrl(site ?? DEFAULT_SITE),
});

/**
 * Build a `Credentials` layer from literal keys. Useful for tests or when
 * callers already have keys in hand.
 */
export const fromKeys = (
  apiKey: string | Redacted.Redacted<string>,
  appKey: string | Redacted.Redacted<string>,
  options?: { readonly site?: string },
) =>
  Layer.succeed(
    Credentials,
    Effect.succeed(make(apiKey, appKey, options?.site)),
  );

/**
 * Build a `Credentials` layer that reads keys from the environment:
 * `DD_API_KEY` / `DATADOG_API_KEY`, `DD_APP_KEY` / `DATADOG_APP_KEY`, and
 * the optional `DD_SITE` / `DATADOG_SITE` (defaults to `datadoghq.com`).
 */
export const fromEnv = () =>
  Layer.succeed(
    Credentials,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("DD_API_KEY").pipe(
        Config.orElse(() => Config.redacted("DATADOG_API_KEY")),
      );
      const appKey = yield* Config.redacted("DD_APP_KEY").pipe(
        Config.orElse(() => Config.redacted("DATADOG_APP_KEY")),
      );
      const site = yield* Config.string("DD_SITE").pipe(
        Config.orElse(() => Config.string("DATADOG_SITE")),
        Config.withDefault(DEFAULT_SITE),
      );
      return make(apiKey, appKey, site);
    }).pipe(Effect.orDie),
  );

/**
 * Build a `Credentials` layer that resolves Datadog credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const profile = yield* AlchemyProfile;
      const auth = yield* getAuthProvider<
        DatadogAuthConfig,
        DatadogResolvedCredentials
      >(DATADOG_AUTH_PROVIDER_NAME);
      const profileName = yield* ALCHEMY_PROFILE;
      const ci = yield* Config.boolean("CI").pipe(Config.withDefault(false));

      return yield* profile.loadOrConfigure(auth, profileName, { ci }).pipe(
        Effect.flatMap((config) =>
          auth.read(profileName, config as DatadogAuthConfig),
        ),
        Effect.map((creds) => make(creds.apiKey, creds.appKey, creds.site)),
        Effect.mapError(
          (e) =>
            new AuthError({
              message: `Failed to resolve Datadog credentials for profile '${profileName}': ${(e as { message?: string }).message ?? String(e)}`,
            }),
        ),
        Effect.orDie,
        Effect.cached,
      );
    }),
  );
