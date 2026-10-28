import type * as SDK from "@1password/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import packageJson from "../../package.json" with { type: "json" };
import type { OnePasswordResolvedCredentials } from "../AuthProvider.ts";
import {
  OnePasswordRateLimitError,
  OnePasswordReferenceError,
  OnePasswordSecretsError,
  type OnePasswordOperation,
} from "../Errors.ts";
import type { OnePasswordOptions } from "../SecretsProvider.ts";

type Sdk = Pick<
  typeof SDK,
  | "DesktopAuth"
  | "RateLimitExceededError"
  | "AuthExpiredError"
  | "DesktopSessionExpiredError"
  | "Secrets"
> & {
  readonly createClient: (config: Parameters<typeof SDK.createClient>[0]) => Promise<{
    readonly environments: Pick<SDK.Client["environments"], "getVariables">;
    readonly secrets: Pick<SDK.Client["secrets"], "resolveAll">;
  }>;
};

/** Internal I/O boundary: importing a provider or discovering auth never loads the SDK. */
export const OnePasswordSdk = Context.Reference<{ readonly load: () => Promise<Sdk> }>(
  "1passwordSdk",
  {
    defaultValue: () => ({ load: () => import("@1password/sdk") }),
  },
);

export const loadSecrets = Effect.fn("1password.loadSecrets")(function* (
  options: OnePasswordOptions,
  credentials: OnePasswordResolvedCredentials,
) {
  const { environmentId, references } = options;
  const boundary = yield* OnePasswordSdk;
  const sdk = yield* Effect.tryPromise({
    try: () => boundary.load(),
    catch: () =>
      new OnePasswordSecretsError({ environmentId, operation: "initialize", reason: "SdkError" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new OnePasswordSecretsError({
            environmentId,
            operation: "initialize",
            reason: "Timeout",
          }),
        ),
    }),
  );

  // The public schema checks syntax without importing the SDK. Also ask the
  // pinned SDK to validate offline, before opening an authenticated session.
  if (references !== undefined) {
    for (const [configKey, reference] of Object.entries(references)) {
      yield* Effect.try({
        try: () => sdk.Secrets.validateSecretReference(reference),
        catch: () => new OnePasswordReferenceError({ configKey, reason: "InvalidReference" }),
      });
    }
  }

  const call = <A>(
    operation: OnePasswordOperation,
    run: () => Promise<A>,
    timeout: "60 seconds" | "30 seconds",
  ) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        cause instanceof sdk.RateLimitExceededError
          ? new OnePasswordRateLimitError({ environmentId, operation })
          : new OnePasswordSecretsError({
              environmentId,
              operation,
              reason:
                cause instanceof sdk.AuthExpiredError
                  ? "AuthExpired"
                  : cause instanceof sdk.DesktopSessionExpiredError
                    ? "DesktopSessionExpired"
                    : "SdkError",
            }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new OnePasswordSecretsError({ environmentId, operation, reason: "Timeout" })),
      }),
    );

  const client = yield* call(
    "authenticate",
    () =>
      sdk.createClient({
        auth:
          credentials.method === "service-account"
            ? Redacted.value(credentials.token)
            : new sdk.DesktopAuth(credentials.account),
        integrationName: "Alchemy",
        integrationVersion: packageJson.version,
      }),
    credentials.method === "desktop" ? "60 seconds" : "30 seconds",
  );
  // Fetch once when this layer is built. Config lookups use the in-memory map;
  // neither initialization nor reads are retried on exhausted hourly/daily quotas.
  const env: Record<string, string> = Object.create(null);
  if (references !== undefined) {
    const unique = [...new Set(Object.values(references))];
    const result = yield* call("resolve", () => client.secrets.resolveAll(unique), "30 seconds");
    for (const [configKey, reference] of Object.entries(references)) {
      const response = Object.hasOwn(result.individualResponses, reference)
        ? result.individualResponses[reference]
        : undefined;
      if (!response || response.error || typeof response.content?.secret !== "string") {
        return yield* new OnePasswordReferenceError({
          configKey,
          reason: response ? "ResolutionFailed" : "MissingResponse",
        });
      }
      env[configKey] = response.content.secret;
    }
  } else {
    const result = yield* call(
      "read",
      () => client.environments.getVariables(environmentId),
      "30 seconds",
    );
    for (const variable of result.variables) {
      if (
        !variable.name ||
        typeof variable.value !== "string" ||
        Object.hasOwn(env, variable.name)
      ) {
        return yield* new OnePasswordSecretsError({
          environmentId,
          operation: "read",
          reason: "InvalidEnvironment",
        });
      }
      env[variable.name] = variable.value;
    }
  }
  return env;
});
