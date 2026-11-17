import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import packageJson from "../../package.json" with { type: "json" };
import type { OnePasswordResolvedCredentials } from "../AuthProvider.ts";
import {
  OnePasswordRateLimitError,
  OnePasswordReferenceError,
  OnePasswordAccountNotFoundError,
  OnePasswordAuthExpiredError,
  OnePasswordDesktopSessionExpiredError,
  OnePasswordSdkError,
  OnePasswordTimeoutError,
  type OnePasswordOperation,
} from "../Errors.ts";

/**
 * Read every variable of an Environment, or resolve vault references keyed by
 * their config keys. Fetched once; config lookups then read the returned map.
 * Rate limits are not retried: service-account quotas can take hours to reset.
 */
export const loadSecrets = Effect.fn("1password.loadSecrets")(function* (
  source:
    | { readonly environmentId: string; readonly references?: undefined }
    | { readonly references: Readonly<Record<string, string>>; readonly environmentId?: undefined },
  credentials: OnePasswordResolvedCredentials,
) {
  const { environmentId, references } = source;

  // Keep discovery offline: load the SDK only when secrets are read.
  const sdk = yield* Effect.tryPromise({
    try: () => import("@1password/sdk"),
    catch: () => new OnePasswordSdkError({ environmentId, operation: "initialize" }),
  });

  // Raw SDK errors may echo references or values, so only their kind is kept.
  const call = <A>(operation: OnePasswordOperation, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        Match.value(cause).pipe(
          Match.when(
            Match.instanceOf(sdk.RateLimitExceededError),
            () => new OnePasswordRateLimitError({ environmentId, operation }),
          ),
          Match.when(
            Match.instanceOf(sdk.AuthExpiredError),
            () => new OnePasswordAuthExpiredError(),
          ),
          Match.when(
            Match.instanceOf(sdk.DesktopSessionExpiredError),
            () => new OnePasswordDesktopSessionExpiredError(),
          ),
          // The SDK reports an unknown desktop account as a plain Error.
          Match.when(
            (cause: unknown) =>
              Predicate.isError(cause) && cause.message.includes("Account not found"),
            () =>
              credentials.method === "desktop"
                ? new OnePasswordAccountNotFoundError({ account: credentials.account })
                : new OnePasswordSdkError({ environmentId, operation }),
          ),
          Match.orElse(() => new OnePasswordSdkError({ environmentId, operation })),
        ),
    }).pipe(
      Effect.timeoutOrElse({
        // Desktop authorization waits for the user to approve the prompt.
        duration:
          operation === "authenticate" && credentials.method === "desktop"
            ? "60 seconds"
            : "30 seconds",
        orElse: () => Effect.fail(new OnePasswordTimeoutError({ operation })),
      }),
    );

  // The desktop app asks the user to authorize Alchemy once per process.
  const client = yield* call("authenticate", () =>
    sdk.createClient({
      auth:
        credentials.method === "service-account"
          ? Redacted.value(credentials.token)
          : new sdk.DesktopAuth(credentials.account),
      integrationName: "Alchemy",
      integrationVersion: packageJson.version,
    }),
  );

  const env: Record<string, string> = Object.create(null);

  if (references !== undefined) {
    const result = yield* call("resolve", () =>
      client.secrets.resolveAll([...new Set(Object.values(references))]),
    );
    for (const [configKey, reference] of Object.entries(references)) {
      const response = result.individualResponses[reference];
      const secret = response?.content?.secret;
      if (!Predicate.isString(secret)) {
        return yield* new OnePasswordReferenceError({
          configKey,
          errorType: response?.error?.type,
        });
      }
      env[configKey] = secret;
    }
    return env;
  }

  const result = yield* call("read", () => client.environments.getVariables(environmentId));
  for (const variable of result.variables) {
    env[variable.name] = variable.value;
  }
  return env;
});
