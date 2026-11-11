import {
  AuthError,
  AuthProviderLayer,
  type ConfigureField,
  type ConfigureMethod,
  NeedsReauth,
  refreshHint,
} from "alchemy/Auth/AuthProvider";
import { displayRedacted } from "alchemy/Auth/Credentials";
import {
  getEnv,
  getEnvRedactedRequired,
  getEnvRequired,
  mapPromptCancellation,
} from "alchemy/Auth/Env";
import { withProfileCredentialsLock } from "alchemy/Auth/Lock";
import { storedValueText, validateFieldValues } from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  awaitDeviceSignIn,
  type CloudAuth,
  type DeviceSession,
  endDeviceSession,
  listClusters,
  listOrganizations,
  refreshDeviceSession,
  type RivetCloudApiError,
  startDeviceSignIn,
} from "./Api.ts";

/**
 * The name Rivet Cloud credentials are registered and stored under. It is
 * not `Rivet`: self-hosted control planes need no Rivet account, so Rivet's
 * own resources never demand these credentials.
 */
export const RIVET_CLOUD_AUTH_PROVIDER_NAME = "RivetCloud";

/**
 * A Rivet Cloud profile: a browser sign-in (`login`), which refreshes
 * itself, or a cluster token created in the Rivet dashboard (`stored`), for
 * CI. Both name the cluster deploys use. A sign-in also names the
 * organization it acts in when the account belongs to several.
 */
export const RivetCloudAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("login"),
    cluster: Schema.String,
    /** The organization's slug, for an account in several. */
    organization: Schema.optional(Schema.String),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
  }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    cluster: Schema.String,
    token: Schema.String,
  }),
]);
export type RivetCloudAuthConfig = typeof RivetCloudAuthConfigSchema.Type;
type LoginConfig = Extract<RivetCloudAuthConfig, { method: "login" }>;

/** Rivet Cloud credentials, as a deploy uses them. */
export interface RivetCloudCredentials {
  /** A bearer token for the Cloud API: a sign-in session or a cluster token. */
  readonly token: Redacted.Redacted<string>;
  /** The cluster's name. */
  readonly cluster: string;
  /** The organization a sign-in session acts in, for an account in several. */
  readonly organization?: string | undefined;
  /** When {@link token} expires, for a sign-in session. */
  readonly expires?: number;
  readonly source: "login" | "stored" | "env";
}

const toAuthError = (cause: RivetCloudApiError | AuthError) =>
  cause._tag === "AuthError"
    ? cause
    : AuthError.make({ message: `RivetCloud: ${cause.message}`, cause });

const sessionConfig = Effect.fn(function* (
  cluster: string,
  organization: string | undefined,
  session: DeviceSession,
) {
  const now = yield* Clock.currentTimeMillis;
  return {
    method: "login" as const,
    cluster,
    ...(organization === undefined ? {} : { organization }),
    access: session.access_token,
    refresh: session.refresh_token,
    expires: now + session.expires_in * 1000,
  } satisfies LoginConfig;
});

/**
 * The organization a sign-in session acts in: `RIVET_CLOUD_ORGANIZATION`,
 * none for an account in one, else the user's pick.
 */
const selectOrganization = Effect.fn(function* (
  token: Redacted.Redacted<string>,
  current?: string,
) {
  const named = (yield* getEnv("RIVET_CLOUD_ORGANIZATION"))?.trim();
  if (named !== undefined && named.length > 0) {
    yield* Interaction.info(`RivetCloud: using organization ${named}`);
    return named;
  }
  const organizations = yield* listOrganizations({ token });
  if (organizations.length < 2) return undefined;
  if (!(yield* Interaction.Interaction).terminal.input) {
    return yield* AuthError.make({
      message: `RivetCloud: this account belongs to several organizations (${organizations.map((org) => org.slug).join(", ")}). Set RIVET_CLOUD_ORGANIZATION to the one to act in.`,
    });
  }
  return yield* Interaction.select({
    message: "Select a Rivet Cloud organization",
    options: organizations.map((org) => ({
      value: org.slug,
      label: org.name,
      description: org.slug,
    })),
    ...(organizations.some((org) => org.slug === current) ? { initialValue: current } : {}),
  }).pipe(mapPromptCancellation);
});

/** Pick the cluster deploys use: the only one, or the user's choice. */
const selectCluster = Effect.fn(function* (auth: CloudAuth) {
  const clusters = yield* listClusters(auth);
  if (clusters.length === 0) {
    return yield* AuthError.make({
      message:
        "RivetCloud: this account has no clusters. Create one at https://dashboard.rivet.dev.",
    });
  }
  const [only] = clusters;
  if (clusters.length === 1 && only !== undefined) {
    yield* Interaction.info(`RivetCloud: using cluster ${only.cluster} (${only.domain})`);
    return only.cluster;
  }
  return yield* Interaction.select({
    message: "Select a Rivet Cloud cluster",
    options: clusters.map((cluster) => ({
      value: cluster.cluster,
      label: cluster.cluster,
      description: cluster.domain,
    })),
  }).pipe(mapPromptCancellation);
});

/**
 * Sign in through Rivet Cloud's device flow, the one the Rivet CLI uses:
 * the dashboard asks the user to approve a code. `organization` is the one a
 * previous sign-in acted in, offered first.
 */
const browserSignIn = Effect.fn(function* (organization?: string) {
  const device = yield* startDeviceSignIn;
  const session = yield* Interaction.browserLogin({
    provider: "Rivet Cloud",
    url: device.verification_uri_complete ?? device.verification_uri,
    code: device.user_code,
    waitFor: awaitDeviceSignIn(device),
  });
  const token = Redacted.make(session.access_token);
  const selected = yield* selectOrganization(token, organization);
  const cluster = yield* selectCluster({ token, organization: selected });
  yield* Interaction.success("RivetCloud: signed in.");
  return yield* sessionConfig(cluster, selected, session);
});

const pasteToken = Effect.fn(function* () {
  const cluster = yield* Interaction.text({
    message: "Rivet Cloud cluster name",
    validate: (value) => (value.length === 0 ? "Required" : undefined),
  }).pipe(mapPromptCancellation);
  const token = yield* Interaction.password({
    message: "Rivet Cloud cluster token",
    validate: (value) => (value.length === 0 ? "Required" : undefined),
  }).pipe(mapPromptCancellation);
  yield* Interaction.success("RivetCloud: credentials saved.");
  return { method: "stored" as const, cluster, token } satisfies RivetCloudAuthConfig;
});

const clusterTokenFields: ReadonlyArray<ConfigureField> = [
  { name: "cluster", label: "Rivet Cloud cluster name" },
  {
    name: "token",
    label: "Rivet Cloud cluster token",
    secret: true,
    description:
      "Create one in the Rivet dashboard with the rivet:cluster:read, rivet:cluster:engine:read and rivet:cluster:engine:write scopes.",
  },
];

/**
 * Registers the Rivet Cloud {@link AuthProvider}. Only `RivetCloud.ControlPlane`
 * resolves these credentials; self-hosted control planes never ask for them.
 *
 * - `login`: sign in with the browser; the session refreshes itself.
 * - `stored`: a cluster token from the Rivet dashboard, which never expires.
 *
 * In CI, `RIVET_CLOUD_TOKEN` and `RIVET_CLOUD_CLUSTER` take the place of a
 * profile. A sign-in to an account in several organizations asks which one
 * to act in, or takes it from `RIVET_CLOUD_ORGANIZATION`.
 */
export const RivetCloudAuth = AuthProviderLayer<RivetCloudAuthConfig, RivetCloudCredentials>()(
  RIVET_CLOUD_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const chooseMethod = Effect.gen(function* () {
      // A browser sign-in needs no prompt of its own, so it is the method a
      // terminal without input configures.
      if (!(yield* Interaction.Interaction).terminal.input) return "login" as const;
      return yield* Interaction.select({
        message: "Rivet Cloud authentication method",
        options: [
          {
            value: "login" as const,
            label: "Sign in with the browser",
            description: "recommended — refreshes itself",
          },
          {
            value: "stored" as const,
            label: "Cluster token",
            description: "a token from the Rivet dashboard, for CI",
          },
        ],
      });
    });

    const configure = (_profileName: string) =>
      chooseMethod.pipe(
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("login", () => browserSignIn()),
            Match.when("stored", () => pasteToken()),
            Match.exhaustive,
          ),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError((cause) =>
          cause._tag === "AuthError" || cause._tag === "RivetCloud.ApiError"
            ? toAuthError(cause)
            : AuthError.make({ message: "RivetCloud: sign-in failed", cause }),
        ),
      );

    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "stored", fields: clusterTokenFields },
    ];

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "stored"
        ? validateFieldValues(
            RIVET_CLOUD_AUTH_PROVIDER_NAME,
            clusterTokenFields,
            input.values,
          ).pipe(
            Effect.map((values): RivetCloudAuthConfig => ({
              method: "stored",
              cluster: storedValueText(values.cluster) ?? "",
              token: storedValueText(values.token) ?? "",
            })),
          )
        : Effect.fail(
            AuthError.make({
              message: `RivetCloud: unknown method '${input.method}'. Valid methods: stored. (Browser sign-in is interactive.)`,
            }),
          );

    /**
     * A session that is not about to expire: refreshed and saved when it is.
     * Refresh tokens rotate, so the caller must hold the profile's
     * credentials lock — core takes it around `read` and `details`, and
     * `login` takes it itself.
     */
    const freshSession = (
      profileName: string,
      config: LoginConfig,
      updateConfig?: (config: RivetCloudAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (config.expires > now + 60_000) return config;
        const session = yield* refreshDeviceSession(Redacted.make(config.refresh)).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError((cause) =>
            NeedsReauth.make({
              provider: RIVET_CLOUD_AUTH_PROVIDER_NAME,
              profile: profileName,
              message: `Rivet Cloud sign-in expired. ${refreshHint(RIVET_CLOUD_AUTH_PROVIDER_NAME, profileName)}`,
              cause,
            }),
          ),
        );
        const next = yield* sessionConfig(config.cluster, config.organization, session);
        yield* updateConfig?.(next) ?? Effect.void;
        return next;
      });

    const read = (
      profileName: string,
      config: RivetCloudAuthConfig,
      updateConfig?: (config: RivetCloudAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      config.method === "stored"
        ? Effect.succeed<RivetCloudCredentials>({
            token: Redacted.make(config.token),
            cluster: config.cluster,
            source: "stored",
          })
        : freshSession(profileName, config, updateConfig).pipe(
            Effect.map((session): RivetCloudCredentials => ({
              token: Redacted.make(session.access),
              cluster: session.cluster,
              organization: session.organization,
              expires: session.expires,
              source: "login",
            })),
          );

    const login = (
      profileName: string,
      config: RivetCloudAuthConfig,
      updateConfig?: (config: RivetCloudAuthConfig) => Effect.Effect<void, AuthError>,
      reload?: Effect.Effect<RivetCloudAuthConfig, AuthError>,
    ) =>
      config.method === "stored"
        ? Effect.succeed(config)
        : withProfileCredentialsLock(
            profileName,
            // Refresh the token stored now, read under the lock.
            Effect.gen(function* () {
              const current = yield* reload ?? Effect.succeed<RivetCloudAuthConfig>(config);
              return current.method === "login"
                ? yield* freshSession(profileName, current, updateConfig)
                : current;
            }),
          ).pipe(
            Effect.catchTag("NeedsReauth", () =>
              browserSignIn(config.organization).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.mapError((cause) =>
                  cause._tag === "AuthError" || cause._tag === "RivetCloud.ApiError"
                    ? toAuthError(cause)
                    : AuthError.make({ message: "RivetCloud: sign-in failed", cause }),
                ),
              ),
            ),
          );

    const logout = (_profileName: string, config: RivetCloudAuthConfig) =>
      config.method === "login"
        ? endDeviceSession(Redacted.make(config.refresh)).pipe(
            Effect.provide(FetchHttpClient.layer),
          )
        : Effect.void;

    const details = (
      profileName: string,
      config: RivetCloudAuthConfig,
      updateConfig?: (config: RivetCloudAuthConfig) => Effect.Effect<void, AuthError>,
    ) =>
      read(profileName, config, updateConfig).pipe(
        Effect.map((credentials) => ({
          lines: [
            { key: "cluster", value: credentials.cluster },
            ...(credentials.organization === undefined
              ? []
              : [{ key: "organization", value: credentials.organization }]),
            { key: "token", value: displayRedacted(credentials.token) },
            ...(credentials.expires === undefined
              ? []
              : [{ key: "expires", value: new Date(credentials.expires).toISOString() }]),
            { key: "source", value: credentials.source },
          ],
        })),
      );

    const readEnvironment = Effect.gen(function* () {
      const token = yield* getEnvRedactedRequired("RIVET_CLOUD_TOKEN");
      const cluster = yield* getEnvRequired("RIVET_CLOUD_CLUSTER");
      const organization = (yield* getEnv("RIVET_CLOUD_ORGANIZATION"))?.trim() || undefined;
      return {
        token,
        cluster,
        ...(organization === undefined ? {} : { organization }),
        source: "env" as const,
      } satisfies RivetCloudCredentials;
    });

    return {
      configSchema: RivetCloudAuthConfigSchema,
      configure,
      configureWith,
      configureMethods,
      login,
      logout,
      details,
      read,
      readEnvironment,
      environment: [
        {
          name: "RIVET_CLOUD_TOKEN",
          required: true,
          secret: true,
          description: "A cluster token from the Rivet dashboard.",
        },
        {
          name: "RIVET_CLOUD_CLUSTER",
          required: true,
          description: "The cluster's name.",
        },
        {
          name: "RIVET_CLOUD_ORGANIZATION",
          required: false,
          description:
            "The organization to act in, for an account in several. A cluster token needs none.",
        },
      ],
    };
  }),
);
