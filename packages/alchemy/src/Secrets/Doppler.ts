import { downloadSecret, fromApiKey } from "@distilled.cloud/doppler";
import * as Retry from "@distilled.cloud/doppler/Retry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AuthError, refreshHint } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  DopplerAuth,
  type DopplerAuthConfig,
  type DopplerResolvedCredentials,
} from "../Doppler/AuthProvider.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { logLoadedKeys } from "./Log.ts";

export interface DopplerOptions {
  /** Project slug. Required with browser login or personal tokens. */
  project?: string;
  /** Config slug, e.g. `dev` or `prd`. Required with browser login or personal tokens. */
  config?: string;
}

/** Doppler could not serve the requested secrets (wrong project/config, API outage, ...). */
export class DopplerSecretsError extends Schema.TaggedError<DopplerSecretsError>()(
  "DopplerSecretsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
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
 * Resolve the token through the Doppler auth provider: `DOPPLER_TOKEN` when
 * present, otherwise the selected profile.
 */
const resolveCredentials = Effect.fn("resolveDopplerCredentials")(function* () {
  const resolved = yield* resolveProviderConfig<
    DopplerAuthConfig,
    DopplerResolvedCredentials
  >("Doppler").pipe(Effect.provide(DopplerAuth));
  const { token } = yield* resolved.resolve;
  const credentials: DopplerCredentials = {
    token,
    profileName: resolved.profileName,
    method: resolved.config?.method,
  };
  return credentials;
});

const rejectedTokenMessage = (credentials: DopplerCredentials) =>
  credentials.profileName === undefined
    ? "Doppler rejected the token. Check DOPPLER_TOKEN; to log in locally run `alchemy profile edit --add Doppler`."
    : `Doppler credentials were rejected. ${refreshHint("Doppler", credentials.profileName)}`;

/** Human description of which secrets were asked for, for error messages. */
const describeSelection = (options: DopplerOptions) => {
  if (options.project && options.config) {
    return `project '${options.project}' config '${options.config}'`;
  }
  if (options.project) {
    return `project '${options.project}'`;
  }
  return "the token's own project and config";
};

/**
 * Turn whatever the Doppler SDK failed with into an error that says
 * "Doppler" up front, so a stack trace never has to be read to know which
 * secrets source broke.
 */
const describeFailure = (
  options: DopplerOptions,
  credentials: DopplerCredentials,
  error: { readonly _tag: string; readonly message: string },
) => {
  switch (error._tag) {
    case "Unauthorized":
      return new AuthError({ message: rejectedTokenMessage(credentials) });
    case "NotFound":
      return new DopplerSecretsError({
        message: `Doppler could not find ${describeSelection(options)}: ${error.message}. Check Secrets.Doppler({ project, config }) and that the token has access to it.`,
        cause: error,
      });
    default:
      return new DopplerSecretsError({
        message: `Doppler could not download secrets for ${describeSelection(options)}: ${error.message}`,
        cause: error,
      });
  }
};

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
    Effect.mapError((error) => describeFailure(options, credentials, error)),
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
      const credentials = yield* resolveCredentials();

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
      yield* logLoadedKeys(
        `Doppler (${describeSelection(resolved)})`,
        Object.keys(env).sort(),
      );
      return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
    }),
    { asPrimary: true },
  );
