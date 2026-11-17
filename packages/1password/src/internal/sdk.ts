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

/**
 * The SDK reports an unknown desktop account as a plain Error. Its message
 * names no secret, so it is matched by text.
 */
const accountNotFound = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("Account not found");

type Source =
  | { readonly environmentId: string; readonly references?: undefined }
  | { readonly references: Readonly<Record<string, string>>; readonly environmentId?: undefined };

/** Read every variable of an Environment. */
export const loadEnvironment = (
  environmentId: string,
  credentials: OnePasswordResolvedCredentials,
) => loadSecrets({ environmentId }, credentials);

/** Resolve vault references, keyed by their config keys. */
export const loadSecretReferences = (
  references: Readonly<Record<string, string>>,
  credentials: OnePasswordResolvedCredentials,
) => loadSecrets({ references }, credentials);

const loadSecrets = Effect.fn("1password.loadSecrets")(function* (
  options: Source,
  credentials: OnePasswordResolvedCredentials,
) {
  const { environmentId, references } = options;
  // Keep discovery offline: load the SDK only when this layer reads secrets.
  const sdk = yield* Effect.tryPromise({
    try: () => import("@1password/sdk"),
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

  const call = <A>(
    operation: OnePasswordOperation,
    run: () => Promise<A>,
    timeout: "60 seconds" | "30 seconds",
  ) =>
    Effect.tryPromise({
      try: run,
      // Match against the classes of the module instance that threw.
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
                    : accountNotFound(cause)
                      ? "AccountNotFound"
                      : "SdkError",
              account: credentials.method === "desktop" ? credentials.account : undefined,
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
    // The desktop app asks the user to authorize Alchemy once per process,
    // however many clients a run creates.
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
          // A fixed SDK error kind; its free-text `message` may echo the reference.
          errorType: response?.error?.type,
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
          variableName: variable.name,
        });
      }
      env[variable.name] = variable.value;
    }
  }
  return env;
});
