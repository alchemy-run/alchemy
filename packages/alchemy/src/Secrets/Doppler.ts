import { downloadSecret, fromApiKey } from "@distilled.cloud/doppler";
import * as Retry from "@distilled.cloud/doppler/Retry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { AuthError, refreshHint } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  DopplerAuth,
  type DopplerAuthConfig,
  type DopplerResolvedCredentials,
} from "../Doppler/AuthProvider.ts";

export interface DopplerOptions {
  /** Project slug. Required with browser login or personal tokens. */
  project?: string;
  /** Config slug, e.g. `dev` or `prd`. Required with browser login or personal tokens. */
  config?: string;
  /** Explicit credential, used before `DOPPLER_TOKEN` and the selected profile. */
  token?: Redacted.Redacted<string>;
}

/** A provider that knows nothing. */
const emptyProvider = ConfigProvider.fromEnv({ env: {} });

interface DopplerCredentials {
  readonly token: Redacted.Redacted<string>;
  /** Set when the token came from a stored Alchemy profile. */
  readonly profileName?: string;
  /** How the stored profile authenticated, when the token came from one. */
  readonly method?: DopplerAuthConfig["method"];
}

/**
 * Pick the token to call Doppler with: an explicit option first, otherwise
 * whatever the Doppler auth provider resolves (`DOPPLER_TOKEN`, then the
 * selected profile).
 */
const resolveCredentials = Effect.fn("resolveDopplerCredentials")(function* (
  options: DopplerOptions,
) {
  if (options.token !== undefined) {
    const explicit: DopplerCredentials = { token: options.token };
    return explicit;
  }
  const resolved = yield* resolveProviderConfig<
    DopplerAuthConfig,
    DopplerResolvedCredentials
  >("Doppler").pipe(Effect.provide(DopplerAuth));
  const { token } = yield* resolved.resolve;
  const stored: DopplerCredentials = {
    token,
    profileName: resolved.profileName,
    method: resolved.config?.method,
  };
  return stored;
});

const rejectedTokenMessage = (credentials: DopplerCredentials) =>
  credentials.profileName === undefined
    ? "Doppler rejected the token. Check the explicit token or DOPPLER_TOKEN; to log in locally run `alchemy profile edit --add Doppler`."
    : `Doppler credentials were rejected. ${refreshHint("Doppler", credentials.profileName)}`;

/** Download every secret of the selected project/config as a flat env map. */
const downloadSecrets = Effect.fn("downloadDopplerSecrets")(function* (
  options: DopplerOptions,
  credentials: DopplerCredentials,
) {
  const secrets = yield* downloadSecret({
    project: options.project,
    config: options.config,
    format: "json",
  }).pipe(
    Retry.none,
    Effect.provide(fromApiKey({ apiKey: credentials.token })),
    Effect.timeout("30 seconds"),
    Effect.catchTag("Unauthorized", () =>
      Effect.fail(
        new AuthError({ message: rejectedTokenMessage(credentials) }),
      ),
    ),
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
});

/**
 * Load Doppler secrets into Effect Config without touching `process.env`.
 * Later secrets layers win; the process environment keeps the highest
 * priority. Config-scoped service tokens may omit `project` and `config`.
 *
 * Authenticate locally with `alchemy profile edit --add Doppler` and choose
 * Login or API token. In CI, set `DOPPLER_TOKEN`. Loading secrets never
 * starts a login flow.
 *
 * ```ts
 * secrets: [Secrets.Doppler(Effect.gen(function* () {
 *   const stage = yield* Stage;
 *   return { project: "my-app", config: stage === "prod" ? "prd" : "dev" };
 * }))]
 * ```
 */
export const Doppler = <E = never, R = never>(
  options: DopplerOptions | Effect.Effect<DopplerOptions, E, R> = {},
) =>
  ConfigProvider.layerAdd(
    Effect.gen(function* () {
      // Auth-provider discovery builds stack layers just to find out which
      // providers are used. It must work offline and with expired tokens, so
      // the user can configure or refresh the very token this layer needs.
      const discoveringAuthProviders = yield* SuppressMissingProviderConfig;
      if (discoveringAuthProviders) {
        return emptyProvider;
      }

      const resolved = Effect.isEffect(options) ? yield* options : options;
      const credentials = yield* resolveCredentials(resolved);

      // Browser-login tokens are personal tokens: they can see every project,
      // so Doppler needs to be told which one to read.
      const missingSelector = !resolved.project || !resolved.config;
      if (credentials.method === "login" && missingSelector) {
        return yield* new AuthError({
          message:
            "Doppler browser login requires both project and config in Secrets.Doppler({ project, config }).",
        });
      }

      const env = yield* downloadSecrets(resolved, credentials);
      return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
    }),
    { asPrimary: true },
  );
