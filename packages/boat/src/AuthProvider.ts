import * as boat from "@distilled.cloud/boat-dev";
import { DEFAULT_API_BASE_URL, fromApiKey } from "@distilled.cloud/boat-dev/Credentials";
import * as Login from "@distilled.cloud/boat-dev/Login";
import {
  AuthError,
  AuthProviderLayer,
  NeedsReauth,
  refreshHint,
  type ConfigureField,
  type ConfigureMethod,
  type ProviderDetails,
} from "alchemy/Auth/AuthProvider";
import { displayRedacted } from "alchemy/Auth/Credentials";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "alchemy/Auth/Env";
import {
  collectFieldValues,
  storedSecret,
  storedValueText,
  validateFieldValues,
  type StoredValues,
} from "alchemy/Auth/StoredAuthProvider";
import * as Interaction from "alchemy/Interaction";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Boat AuthProvider from inside provider Layers.
 */
export const BOAT_AUTH_PROVIDER_NAME = "Boat";

/**
 * A Boat profile entry. Both methods store a Boat API key (`boat_…`):
 *
 * - `browser`: Boat's agent sign-in (https://boat.dev/auth.md). You sign in
 *   to boat.dev with GitHub, Google or an email code, type the code Alchemy
 *   shows, and Boat issues a key. The identity assertion that comes with it
 *   mints the next key when this one expires.
 * - `stored`: you paste a key created with `boat api-keys create` or on the
 *   dashboard.
 *
 * Either may pin `org`, the organization Alchemy works in, the way the
 * dashboard's organization select or `boat --org` do: every call bills it
 * (`X-Boat-Org`), and `Boat.Environment` manages its shared environments.
 * Sign-in picks the account's organization (asking only when it belongs
 * to several) and stores its id (`team_…`), which survives renames, with
 * `orgName` for display.
 * Without it, sandboxes bill the account's active wallet (`boat org
 * switch`) and environments are personal.
 *
 * A revoked key fails with Boat's `unauthorized` error; run
 * `alchemy profile edit --reconfigure Boat` to sign in again.
 */
export const BoatAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("browser"),
    email: Schema.String,
    apiKey: Schema.String,
    identityAssertion: Schema.optional(Schema.String),
    /** Epoch millis the key expires at, when Boat says. */
    expires: Schema.optional(Schema.Number),
    account: Schema.optional(Schema.String),
    org: Schema.optional(Schema.String),
    orgName: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    apiKey: Schema.String,
    org: Schema.optional(Schema.String),
    orgName: Schema.optional(Schema.String),
  }),
]);
export type BoatAuthConfig = typeof BoatAuthConfigSchema.Type;
type BrowserConfig = Extract<BoatAuthConfig, { method: "browser" }>;

/** Resolved Boat credentials: an API key sent as a bearer token. */
export interface BoatResolvedCredentials {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiBaseUrl: string;
  /** The organization (wallet) calls bill, sent as `X-Boat-Org`. */
  org?: string;
  source: { type: BoatAuthConfig["method"] | "env"; details?: string };
}

const apiKeyField: ConfigureField = {
  name: "apiKey",
  label: "Boat API key",
  description: "Create one with `boat api-keys create` or at https://boat.dev/dashboard.",
  secret: true,
  validate: (value) => (value.trim().startsWith("boat_") ? undefined : "Expected a boat_… key"),
};

const orgField: ConfigureField = {
  name: "org",
  label: "Boat organization",
  description:
    "The organization to work in: its id (team_…), its name, or `personal`. Leave it out to follow your active wallet.",
  optional: true,
};

/** `--set` fields; interactively the org is picked from a list instead. */
const keyFields: ReadonlyArray<ConfigureField> = [apiKeyField, orgField];

/** A set org, trimmed; blank means the active wallet. */
const orgOf = (value: string | undefined) => {
  const org = value?.trim();
  return org ? { org } : {};
};

const storedConfig = (values: StoredValues): BoatAuthConfig => ({
  method: "stored",
  apiKey: Redacted.value(storedSecret(values.apiKey) ?? Redacted.make("")).trim(),
  ...orgOf(storedValueText(values.org)),
});

/** Sentinel choice: pin nothing and follow the account's active wallet. */
const ACTIVE_WALLET = "";

/**
 * The organization to work in. An account in no organization works
 * personally and one in exactly one works in it, without a question;
 * only an account in several is asked to pick.
 */
const chooseOrg = Effect.fn(function* (apiKey: Redacted.Redacted<string>, current?: string) {
  const { orgs } = yield* boat.listOrganizations({}).pipe(
    Effect.provide(Layer.mergeAll(fromApiKey({ apiKey }), FetchHttpClient.layer)),
    Effect.mapError((cause) =>
      AuthError.make({ message: "Boat: could not list your organizations.", cause }),
    ),
  );
  const teams = orgs.filter((org) => org.type === "org");
  if (teams.length === 0) return {};
  if (teams.length === 1) {
    const [team] = teams;
    yield* Interaction.info(`Boat: working in ${team!.name}.`);
    return { org: team!.id, orgName: team!.name };
  }
  const active = orgs.find((org) => org.active);
  const org = yield* Interaction.select({
    message: "Boat organization to work in",
    options: [
      ...teams.map((team) => ({
        value: team.id,
        label: team.name,
        description: `${team.role ?? "member"}: sandboxes bill it, environments are its shared ones`,
      })),
      {
        value: "personal",
        label: "Personal",
        description: "your own wallet and your personal environments",
      },
      {
        value: ACTIVE_WALLET,
        label: "Follow the active wallet",
        description: `whatever \`boat org switch\` picks (now ${active?.name ?? "Personal"}); environments stay personal`,
      },
    ],
    initialValue: current ?? (active?.type === "org" ? active.id : teams[0]!.id),
  }).pipe(mapPromptCancellation);
  if (org === ACTIVE_WALLET) return {};
  const orgName = org === "personal" ? "Personal" : teams.find((team) => team.id === org)?.name;
  return { org, ...(orgName ? { orgName } : {}) };
});

const loginFailed = (cause: { readonly message: string }) =>
  AuthError.make({ message: `Boat: browser sign-in failed: ${cause.message}`, cause });

/** The account a key acts for, as `boat whoami` shows it. */
const accountOf = (apiKey: Redacted.Redacted<string>) =>
  boat.getCurrentUser({}).pipe(
    Effect.provide(Layer.mergeAll(fromApiKey({ apiKey }), FetchHttpClient.layer)),
    Effect.map(({ user }) => user.email ?? user.login ?? user.displayName ?? user.id),
    Effect.mapError((cause) =>
      AuthError.make({ message: "Boat: the new API key was refused.", cause }),
    ),
  );

/** Fresh codes the sign-in hands out before it gives up. */
const CODE_ROUNDS = 6;

/** Polls give up after this many attempts: about fifteen minutes at 5s. */
const POLL_ATTEMPTS = 180;

const expiryOf = (now: number, expiresIn: number | undefined) =>
  expiresIn === undefined ? {} : { expires: now + expiresIn * 1000 };

/**
 * Boat's agent sign-in: register for the account with the user's email,
 * open the claim page, where the user signs in with any method and types the
 * code, then poll until Boat issues a key.
 */
const browserLogin = (initialEmail?: string, initialOrg?: string) =>
  Effect.gen(function* () {
    const email = (yield* Interaction.text({
      message: "Email of your Boat account",
      description: "You sign in on boat.dev next, with GitHub, Google or an email code.",
      ...(initialEmail ? { initialValue: initialEmail } : {}),
      validate: (value) => (value.includes("@") ? undefined : "Expected an email address"),
    }).pipe(mapPromptCancellation)).trim();
    const http = FetchHttpClient.layer;
    const registered = yield* Login.registerAgent({ email }).pipe(
      Effect.provide(http),
      Effect.mapError(loginFailed),
    );
    const poll = (
      claim: Login.Claim,
      interval: number,
      attempt: number,
    ): Effect.Effect<Login.IssuedKey, AuthError | Login.BoatLoginError> =>
      Effect.sleep(Duration.seconds(interval)).pipe(
        Effect.andThen(
          Login.pollClaim({ claimToken: claim.claimToken, interval }).pipe(Effect.provide(http)),
        ),
        Effect.flatMap((result) =>
          result._tag === "Issued"
            ? Effect.succeed(result.key)
            : attempt >= POLL_ATTEMPTS
              ? Effect.fail(
                  AuthError.make({ message: "Boat: the sign-in wasn't completed in time." }),
                )
              : poll(claim, result.interval, attempt + 1),
        ),
      );
    // A code lapses after about ten minutes (`expired_token`); the claim
    // then hands out a fresh one, shown in a new sign-in prompt.
    const signIn = (
      claim: Login.Claim,
      round: number,
    ): Effect.Effect<Login.IssuedKey, AuthError, Interaction.Interaction | ChildProcessSpawner> =>
      Interaction.browserLogin({
        provider: "Boat",
        url: claim.verificationUri,
        code: claim.userCode,
        waitFor: poll(claim, claim.interval, 1),
      }).pipe(
        Effect.catchIf(
          (e) => e._tag === "BoatLoginError" && e.code === "expired_token" && round < CODE_ROUNDS,
          () =>
            Login.refreshClaim({ claimToken: claim.claimToken, email }).pipe(
              Effect.provide(http),
              Effect.mapError(loginFailed),
              Effect.tap(() => Interaction.info("Boat: the code expired; here is a new one.")),
              Effect.flatMap((next) => signIn(next, round + 1)),
            ),
        ),
        Effect.mapError((e) => (e._tag === "AuthError" ? e : loginFailed(e))),
      );
    const key = yield* signIn(registered, 1);
    const account = yield* accountOf(key.apiKey);
    yield* Interaction.success(`Boat: signed in as ${account ?? email}.`);
    const org = yield* chooseOrg(key.apiKey, initialOrg);
    const now = yield* Clock.currentTimeMillis;
    return {
      method: "browser" as const,
      email,
      apiKey: Redacted.value(key.apiKey),
      ...(key.identityAssertion
        ? { identityAssertion: Redacted.value(key.identityAssertion) }
        : {}),
      ...expiryOf(now, key.expiresIn),
      ...(account ? { account } : {}),
      ...org,
    } satisfies BrowserConfig;
  });

/** Mints a new key from the assertion when the stored one is within a minute of expiring. */
const freshKey = Effect.fn(function* (profileName: string, config: BrowserConfig) {
  const now = yield* Clock.currentTimeMillis;
  if (config.expires === undefined || config.expires > now + 60_000) return config;
  if (config.identityAssertion === undefined) {
    return yield* NeedsReauth.make({
      provider: BOAT_AUTH_PROVIDER_NAME,
      profile: profileName,
      message: `Boat API key expired. ${refreshHint(BOAT_AUTH_PROVIDER_NAME, profileName)}`,
    });
  }
  const key = yield* Login.exchangeAssertion({
    identityAssertion: Redacted.make(config.identityAssertion),
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.mapError((cause) =>
      NeedsReauth.make({
        provider: BOAT_AUTH_PROVIDER_NAME,
        profile: profileName,
        message: `Boat sign-in expired. ${refreshHint(BOAT_AUTH_PROVIDER_NAME, profileName)}`,
        cause,
      }),
    ),
  );
  return {
    ...config,
    apiKey: Redacted.value(key.apiKey),
    ...(key.identityAssertion ? { identityAssertion: Redacted.value(key.identityAssertion) } : {}),
    expires: key.expiresIn === undefined ? undefined : now + key.expiresIn * 1000,
  } satisfies BrowserConfig;
});

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("BOAT_API_KEY");
  if (apiKey === undefined || Redacted.value(apiKey).trim().length === 0) {
    return yield* AuthError.make({
      message: "Boat CI credentials not found. Set BOAT_API_KEY.",
    });
  }
  return {
    type: "apiKey" as const,
    apiKey: Redacted.make(Redacted.value(apiKey).trim()),
    apiBaseUrl: (yield* getEnv("BOAT_API_BASE_URL")) ?? DEFAULT_API_BASE_URL,
    ...orgOf(yield* getEnv("BOAT_ORG")),
    source: { type: "env" as const, details: "BOAT_API_KEY" },
  } satisfies BoatResolvedCredentials;
});

const resolve = (config: BoatAuthConfig): BoatResolvedCredentials => ({
  type: "apiKey",
  apiKey: Redacted.make(config.apiKey),
  apiBaseUrl: DEFAULT_API_BASE_URL,
  ...orgOf(config.org),
  source: {
    type: config.method,
    details: config.method === "browser" ? (config.account ?? config.email) : undefined,
  },
});

/**
 * Layer that registers the Boat {@link AuthProvider} into the
 * `AuthProviders` registry when built. Included in `Boat.providers()` so
 * `alchemy profile edit` can configure it.
 *
 * Supported methods:
 * - `browser`: Boat's browser sign-in with GitHub or Google (interactive only).
 * - `stored`: a pasted API key (`--method stored --set apiKey=-`).
 */
export const BoatAuth = AuthProviderLayer<BoatAuthConfig, BoatResolvedCredentials>()(
  BOAT_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const pasteKey = collectFieldValues([apiKeyField]).pipe(
      Effect.map(storedConfig),
      Effect.flatMap((config) =>
        chooseOrg(Redacted.make(config.apiKey)).pipe(Effect.map((org) => ({ ...config, ...org }))),
      ),
      Effect.tap(() => Interaction.success("Boat: credentials saved.")),
    );

    const configure = (_profileName: string) =>
      Interaction.select({
        message: "Boat authentication method",
        options: [
          {
            value: "browser" as const,
            label: "Browser sign-in",
            description: "recommended — sign in on boat.dev with GitHub, Google or email",
          },
          {
            value: "stored" as const,
            label: "API key",
            description: "paste a boat_… key",
          },
        ],
      }).pipe(
        mapPromptCancellation,
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("browser", () => browserLogin()),
            Match.when("stored", () => pasteKey),
            Match.exhaustive,
          ),
        ),
        Effect.mapError((e) =>
          e._tag === "AuthError"
            ? e
            : AuthError.make({ message: "Boat: failed to configure credentials", cause: e }),
        ),
      );

    /** The browser sign-in needs a person, so only `stored` takes flags. */
    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "stored", fields: keyFields },
    ];

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "stored"
        ? validateFieldValues(BOAT_AUTH_PROVIDER_NAME, keyFields, input.values).pipe(
            Effect.map(storedConfig),
            Effect.tap(() => Interaction.success("Boat: credentials saved.")),
          )
        : Effect.fail(
            AuthError.make({
              message: `Boat: unknown method '${input.method}'. Valid methods: stored. (Browser sign-in is interactive-only.)`,
            }),
          );

    // A key doesn't refresh, so logging in again repeats the browser
    // sign-in; a pasted key stays as it is.
    const login = (_profileName: string, config: BoatAuthConfig) =>
      config.method === "browser"
        ? browserLogin(config.email, config.org).pipe(
            Effect.mapError((e) =>
              e._tag === "AuthError"
                ? e
                : AuthError.make({ message: "Boat: login failed", cause: e }),
            ),
          )
        : Effect.succeed(config);

    const details = (_profileName: string, config: BoatAuthConfig) =>
      Effect.succeed<ProviderDetails>({
        lines: [
          ...(config.method === "browser"
            ? [{ key: "account", value: config.account ?? config.email }]
            : []),
          { key: "apiKey", value: displayRedacted(Redacted.make(config.apiKey)) },
          ...(config.org ? [{ key: "org", value: config.orgName ?? config.org }] : []),
          { key: "source", value: config.method },
        ],
      });

    return {
      configSchema: BoatAuthConfigSchema,
      configure,
      configureWith,
      configureMethods,
      login,
      logout: () => Effect.void,
      details,
      read: (
        profileName: string,
        config: BoatAuthConfig,
        updateConfig?: (config: BoatAuthConfig) => Effect.Effect<void, AuthError>,
      ): Effect.Effect<BoatResolvedCredentials, AuthError | NeedsReauth> =>
        config.method === "stored"
          ? Effect.succeed(resolve(config))
          : freshKey(profileName, config).pipe(
              Effect.tap((fresh) =>
                fresh === config ? Effect.void : (updateConfig?.(fresh) ?? Effect.void),
              ),
              Effect.map(resolve),
            ),
      readEnvironment,
      environment: [
        {
          name: "BOAT_API_KEY",
          required: true,
          secret: true,
          description: "Boat API key (`boat_…`).",
        },
        {
          name: "BOAT_API_BASE_URL",
          required: false,
          description: `Boat API URL override. Defaults to ${DEFAULT_API_BASE_URL}.`,
        },
        {
          name: "BOAT_ORG",
          required: false,
          description:
            "Boat organization (wallet) to bill: an org id (`team_…`), an org name, or `personal`. Defaults to the account's active wallet.",
        },
      ],
    };
  }),
);
