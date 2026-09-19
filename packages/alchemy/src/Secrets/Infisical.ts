import { fromApiKey, listSecretRaw } from "@distilled.cloud/infisical";
import * as Retry from "@distilled.cloud/infisical/Retry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AuthError, refreshHint } from "../Auth/AuthProvider.ts";
import { SuppressMissingProviderConfig } from "../Auth/Profile.ts";
import { resolveProviderConfig } from "../Auth/Resolve.ts";
import {
  InfisicalAuth,
  type InfisicalAuthConfig,
  type InfisicalResolvedCredentials,
} from "../Infisical/AuthProvider.ts";
import { UserFacingError } from "../UserFacingError.ts";

export interface InfisicalOptions {
  /** Project slug. Either this or `projectId` is required. */
  project?: string;
  /** Project id, for tokens whose identity cannot resolve slugs. */
  projectId?: string;
  /** Environment slug, e.g. `dev` or `prod`. */
  environment: string;
  /**
   * Folder to read from.
   * @default "/"
   */
  path?: string;
  /**
   * Also read every sub-folder of `path`.
   * @default false
   */
  recursive?: boolean;
  /**
   * Include secrets imported into the folder from elsewhere. Directly
   * defined secrets win over imported ones.
   * @default true
   */
  includeImports?: boolean;
}

/** Infisical could not serve the requested secrets (wrong project/environment, API outage, ...). */
export class InfisicalSecretsError extends Schema.TaggedError<InfisicalSecretsError>()(
  "InfisicalSecretsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  readonly [UserFacingError] = true;
}

/** A provider that knows nothing. */
const emptyProvider = ConfigProvider.fromEnv({ env: {} });

interface InfisicalCredentials extends InfisicalResolvedCredentials {
  /** Set when the credentials came from a stored Alchemy profile. */
  readonly profileName?: string;
}

/**
 * Resolve credentials through the Infisical auth provider: `INFISICAL_TOKEN`
 * when present, otherwise the selected profile (which mints a token from
 * the stored machine identity).
 */
const resolveCredentials = Effect.fn("resolveInfisicalCredentials")(
  function* () {
    const resolved = yield* resolveProviderConfig<
      InfisicalAuthConfig,
      InfisicalResolvedCredentials
    >("Infisical").pipe(Effect.provide(InfisicalAuth));
    const { token, apiBaseUrl } = yield* resolved.resolve;
    const credentials: InfisicalCredentials = {
      token,
      apiBaseUrl,
      profileName: resolved.profileName,
    };
    return credentials;
  },
);

/** Human description of which secrets were asked for, for error messages. */
const describeSelection = (options: InfisicalOptions) => {
  const project =
    options.project !== undefined
      ? `project '${options.project}'`
      : `project id '${options.projectId}'`;
  const folder = options.path === undefined ? "" : ` path '${options.path}'`;
  return `${project} environment '${options.environment}'${folder}`;
};

const rejectedTokenMessage = (credentials: InfisicalCredentials) =>
  credentials.profileName === undefined
    ? "Infisical rejected the token. Check INFISICAL_TOKEN; to set up a machine identity locally run `alchemy profile edit --add Infisical`."
    : `Infisical credentials were rejected. ${refreshHint("Infisical", credentials.profileName)}`;

/**
 * Turn whatever the Infisical SDK failed with into an error that says
 * "Infisical" up front, so a stack trace never has to be read to know
 * which secrets source broke.
 */
const describeFailure = (
  options: InfisicalOptions,
  credentials: InfisicalCredentials,
  error: { readonly _tag: string; readonly message: string },
) => {
  switch (error._tag) {
    case "Unauthorized":
      return new AuthError({ message: rejectedTokenMessage(credentials) });
    case "NotFound":
    case "Forbidden":
      return new InfisicalSecretsError({
        message: `Infisical could not read ${describeSelection(options)}: ${error.message}. Check Secrets.Infisical({ project, environment }) and that the identity has read access to it.`,
        cause: error,
      });
    default:
      return new InfisicalSecretsError({
        message: `Infisical could not download secrets for ${describeSelection(options)}: ${error.message}`,
        cause: error,
      });
  }
};

const text = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Download the selected secrets (plus imports) as a flat env map. */
const downloadSecrets = Effect.fn("downloadInfisicalSecrets")(function* (
  options: InfisicalOptions,
  credentials: InfisicalCredentials,
) {
  const includeImports = options.includeImports ?? true;
  const response = yield* listSecretRaw({
    workspaceSlug: options.project,
    workspaceId: options.projectId,
    environment: options.environment,
    secretPath: options.path,
    recursive: options.recursive,
    include_imports: includeImports,
    viewSecretValue: true,
    expandSecretReferences: true,
  }).pipe(
    Retry.none,
    Effect.provide(
      fromApiKey({
        apiKey: Redacted.value(credentials.token),
        apiBaseUrl: credentials.apiBaseUrl,
      }),
    ),
    Effect.timeout("30 seconds"),
    Effect.mapError((error) => describeFailure(options, credentials, error)),
  );

  // Imports first so a directly defined secret overwrites an imported one.
  const env: Record<string, string> = {};
  for (const imported of response.imports ?? []) {
    for (const secret of imported.secrets) {
      env[text(secret.secretKey)] = secret.secretValue;
    }
  }
  for (const secret of response.secrets) {
    env[text(secret.secretKey)] = secret.secretValue;
  }
  return env;
});

/**
 * Load Infisical secrets into Effect Config without touching `process.env`.
 * Later secrets layers win; the process environment keeps the highest
 * priority.
 *
 * Authenticate locally with `alchemy profile edit --add Infisical` and
 * paste a machine identity's universal-auth client id and secret; Alchemy
 * mints a fresh access token on every run so nothing expires on you. In
 * CI, set `INFISICAL_TOKEN` (for example from an OIDC login step).
 *
 * ```ts
 * secrets: [Secrets.Infisical(Effect.gen(function* () {
 *   const stage = yield* Stage;
 *   return { project: "my-app", environment: stage === "prod" ? "prod" : "dev" };
 * }))]
 * ```
 */
export const Infisical = <E = never, R = never>(
  options: InfisicalOptions | Effect.Effect<InfisicalOptions, E, R>,
) =>
  ConfigProvider.layerAdd(
    Effect.gen(function* () {
      // Auth-provider discovery builds stack layers just to find out which
      // providers are used. It must work offline and with broken
      // credentials, so the user can configure the very identity this
      // layer needs.
      const discoveringAuthProviders = yield* SuppressMissingProviderConfig;
      if (discoveringAuthProviders) {
        return emptyProvider;
      }

      const resolved = Effect.isEffect(options) ? yield* options : options;
      if (resolved.project === undefined && resolved.projectId === undefined) {
        return yield* new InfisicalSecretsError({
          message:
            "Secrets.Infisical needs either `project` (slug) or `projectId`.",
        });
      }

      const credentials = yield* resolveCredentials();
      const env = yield* downloadSecrets(resolved, credentials);
      return ConfigProvider.fromEnv({ env, preserveEmptyStrings: true });
    }),
    { asPrimary: true },
  );
