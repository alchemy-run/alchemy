import { anonymous, DEFAULT_API_BASE_URL } from "@distilled.cloud/modal/Credentials";
import * as token from "@distilled.cloud/modal/token";
import {
  AuthError,
  AuthProviderLayer,
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
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Modal AuthProvider from inside provider Layers.
 */
export const MODAL_AUTH_PROVIDER_NAME = "Modal";

/**
 * A Modal profile entry. Both methods store a workspace token pair, the
 * same kind `modal token new` writes to `~/.modal.toml`:
 *
 * - `browser`: Alchemy runs Modal's browser token flow, you approve it on
 *   modal.com, and Modal mints the pair.
 * - `stored`: you paste a pair created at https://modal.com/settings/tokens.
 *
 * Modal tokens don't expire unless created with an expiry, so there is
 * nothing to refresh. A revoked token fails with Modal's auth error; run
 * `alchemy profile edit --reconfigure Modal` to get a new one.
 */
export const ModalAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("browser"),
    tokenId: Schema.String,
    tokenSecret: Schema.String,
    workspace: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("stored"),
    tokenId: Schema.String,
    tokenSecret: Schema.String,
  }),
]);
export type ModalAuthConfig = typeof ModalAuthConfigSchema.Type;

/** Resolved Modal credentials: a workspace token pair. */
export interface ModalResolvedCredentials {
  type: "token";
  tokenId: Redacted.Redacted<string>;
  tokenSecret: Redacted.Redacted<string>;
  apiBaseUrl: string;
  source: { type: ModalAuthConfig["method"] | "env"; details?: string };
}

const trimmed = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined || Redacted.value(value).trim().length === 0
    ? undefined
    : Redacted.make(Redacted.value(value).trim());

const tokenFields: ReadonlyArray<ConfigureField> = [
  {
    name: "tokenId",
    label: "Modal Token ID",
    description:
      "Create one at https://modal.com/settings/tokens, or run `modal token new` and copy token_id from ~/.modal.toml.",
    validate: (value) => (value.trim().startsWith("ak-") ? undefined : "Expected an ak-… id"),
  },
  {
    name: "tokenSecret",
    label: "Modal Token Secret",
    secret: true,
    validate: (value) => (value.trim().startsWith("as-") ? undefined : "Expected an as-… secret"),
  },
];

const storedConfig = (values: StoredValues): ModalAuthConfig => ({
  method: "stored",
  tokenId: (storedValueText(values.tokenId) ?? "").trim(),
  tokenSecret: Redacted.value(storedSecret(values.tokenSecret) ?? Redacted.make("")).trim(),
});

const methods: Array<{
  value: ModalAuthConfig["method"];
  label: string;
  description?: string;
}> = [
  {
    value: "browser",
    label: "Browser login",
    description: "recommended — approve on modal.com and Modal mints a token",
  },
  {
    value: "stored",
    label: "Token",
    description: "paste a token pair from modal.com/settings/tokens",
  },
];

/** How long one `waitTokenFlow` call long-polls, as `modal token new` does. */
const WAIT_SECONDS = 40;

/** Long-polls before the login gives up: 8 × 40s, about five minutes. */
const WAIT_ATTEMPTS = 8;

const loginFailed = (cause: unknown) =>
  AuthError.make({ message: "Modal: browser login failed.", cause });

/**
 * Modal's browser token flow, the one `modal token new` runs: create a flow,
 * open its page for the user to approve, then long-poll until Modal hands
 * back the new token pair. Both calls run without a token.
 */
const browserLogin = Effect.gen(function* () {
  const anonymousApi = Layer.mergeAll(anonymous(), FetchHttpClient.layer);
  const flow = yield* token
    .createTokenFlow({ utmSource: "alchemy" })
    .pipe(Effect.provide(anonymousApi), Effect.mapError(loginFailed));
  if (!flow.tokenFlowId || !flow.webUrl) {
    return yield* AuthError.make({ message: "Modal: the token flow returned no login page." });
  }
  const waitOnce = token
    .waitTokenFlow({
      tokenFlowId: flow.tokenFlowId,
      waitSecret: flow.waitSecret,
      timeout: WAIT_SECONDS,
    })
    .pipe(Effect.provide(anonymousApi), Effect.mapError(loginFailed));
  const approved = waitOnce.pipe(
    Effect.repeat({ until: (result) => result.timeout !== true, times: WAIT_ATTEMPTS - 1 }),
    Effect.flatMap((result) =>
      result.timeout === true || !result.tokenId || !result.tokenSecret
        ? Effect.fail(
            AuthError.make({
              message: "Modal: the browser login wasn't approved within five minutes.",
            }),
          )
        : Effect.succeed({
            tokenId: result.tokenId,
            tokenSecret: Redacted.isRedacted(result.tokenSecret)
              ? Redacted.value(result.tokenSecret)
              : result.tokenSecret,
            workspace: result.workspaceUsername || undefined,
          }),
    ),
  );
  const minted = yield* Interaction.browserLogin({
    provider: "Modal",
    url: flow.webUrl,
    code: flow.code || undefined,
    waitFor: approved,
  }).pipe(Effect.mapError((e) => (e._tag === "AuthError" ? e : loginFailed(e))));
  yield* Interaction.success(
    minted.workspace
      ? `Modal: logged in to the ${minted.workspace} workspace.`
      : "Modal: logged in.",
  );
  return { method: "browser" as const, ...minted } satisfies ModalAuthConfig;
});

const readEnvironment = Effect.gen(function* () {
  const tokenId = trimmed(yield* getEnvRedacted("MODAL_TOKEN_ID"));
  const tokenSecret = trimmed(yield* getEnvRedacted("MODAL_TOKEN_SECRET"));
  if (tokenId === undefined || tokenSecret === undefined) {
    return yield* AuthError.make({
      message: "Modal CI credentials not found. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
    });
  }
  return {
    type: "token" as const,
    tokenId,
    tokenSecret,
    apiBaseUrl: (yield* getEnv("MODAL_SERVER_URL")) ?? DEFAULT_API_BASE_URL,
    source: { type: "env" as const, details: "MODAL_TOKEN_ID" },
  } satisfies ModalResolvedCredentials;
});

const resolve = (config: ModalAuthConfig): ModalResolvedCredentials => ({
  type: "token",
  tokenId: Redacted.make(config.tokenId),
  tokenSecret: Redacted.make(config.tokenSecret),
  apiBaseUrl: DEFAULT_API_BASE_URL,
  source: {
    type: config.method,
    details: config.method === "browser" ? config.workspace : undefined,
  },
});

/**
 * Layer that registers the Modal {@link AuthProvider} into the
 * `AuthProviders` registry when built. Included in `Modal.providers()` so
 * `alchemy profile edit` can configure it.
 *
 * Supported methods:
 * - `browser`: Modal's browser token flow (interactive only).
 * - `stored`: a pasted token pair (`--method stored --set tokenId=… --set tokenSecret=…`).
 */
export const ModalAuth = AuthProviderLayer<ModalAuthConfig, ModalResolvedCredentials>()(
  MODAL_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const pasteToken = collectFieldValues(tokenFields).pipe(
      Effect.map(storedConfig),
      Effect.tap(() => Interaction.success("Modal: credentials saved.")),
    );

    const configure = (_profileName: string) =>
      Interaction.select({ message: "Modal authentication method", options: methods }).pipe(
        mapPromptCancellation,
        Effect.flatMap((method) =>
          Match.value(method).pipe(
            Match.when("browser", () => browserLogin),
            Match.when("stored", () => pasteToken),
            Match.exhaustive,
          ),
        ),
        Effect.mapError((e) =>
          e._tag === "AuthError"
            ? e
            : AuthError.make({ message: "failed to configure credentials", cause: e }),
        ),
      );

    /** The browser flow needs a person, so only `stored` takes flags. */
    const configureMethods: ReadonlyArray<ConfigureMethod> = [
      { method: "stored", fields: tokenFields },
    ];

    const configureWith = (
      _profileName: string,
      input: { readonly method: string; readonly values: Record<string, string> },
    ) =>
      input.method === "stored"
        ? validateFieldValues(MODAL_AUTH_PROVIDER_NAME, tokenFields, input.values).pipe(
            Effect.map(storedConfig),
            Effect.tap(() => Interaction.success("Modal: credentials saved.")),
          )
        : Effect.fail(
            AuthError.make({
              message: `Modal: unknown method '${input.method}'. Valid methods: stored. (Browser login is interactive-only.)`,
            }),
          );

    // A token pair doesn't expire on its own, so logging in again only
    // repeats the browser flow; a pasted token stays as it is.
    const login = (_profileName: string, config: ModalAuthConfig) =>
      config.method === "browser" ? browserLogin : Effect.succeed(config);

    const details = (_profileName: string, config: ModalAuthConfig) =>
      Effect.succeed<ProviderDetails>({
        lines: [
          { key: "tokenId", value: config.tokenId },
          { key: "tokenSecret", value: displayRedacted(Redacted.make(config.tokenSecret)) },
          ...(config.method === "browser" && config.workspace
            ? [{ key: "workspace", value: config.workspace }]
            : []),
          { key: "source", value: config.method },
        ],
      });

    return {
      configSchema: ModalAuthConfigSchema,
      configure,
      configureWith,
      configureMethods,
      login,
      logout: () => Effect.void,
      details,
      read: (_profileName: string, config: ModalAuthConfig) => Effect.succeed(resolve(config)),
      readEnvironment,
      environment: [
        { name: "MODAL_TOKEN_ID", required: true, description: "Modal token id (`ak-…`)." },
        {
          name: "MODAL_TOKEN_SECRET",
          required: true,
          secret: true,
          description: "Modal token secret (`as-…`).",
        },
        { name: "MODAL_SERVER_URL", required: false, description: "Modal API URL override." },
      ],
    };
  }),
);
