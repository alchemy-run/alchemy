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

type Client = Awaited<ReturnType<typeof import("@1password/sdk").createClient>>;

const desktopClientsKey = Symbol.for("alchemy.1password.desktopClients");
const desktopClients = ((globalThis as { [desktopClientsKey]?: Map<string, Promise<Client>> })[
  desktopClientsKey
] ??= new Map());

/**
 * The SDK reports an unknown desktop account as a plain Error. Its message
 * names no secret, so it is matched by text.
 */
const accountNotFound = (cause: unknown) =>
  cause instanceof Error && cause.message.includes("Account not found");

export const loadSecrets = Effect.fn("1password.loadSecrets")(function* (
  options: OnePasswordOptions,
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
      catch: (cause) => {
        // A locked or expired desktop session needs a new authorization.
        if (cause instanceof sdk.DesktopSessionExpiredError && credentials.method === "desktop") {
          desktopClients.delete(credentials.account);
        }
        return cause instanceof sdk.RateLimitExceededError
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
            });
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(new OnePasswordSecretsError({ environmentId, operation, reason: "Timeout" })),
      }),
    );

  const client = yield* call(
    "authenticate",
    (): Promise<Client> => {
      if (credentials.method === "service-account") {
        return sdk.createClient({
          auth: Redacted.value(credentials.token),
          integrationName: "Alchemy",
          integrationVersion: packageJson.version,
        });
      }
      // Each desktop client asks the user to authorize it, so reuse one per
      // account for the whole process: several Secrets entries, stacks and
      // `alchemy dev` reloads then share a single prompt. The cache lives on
      // globalThis so it survives a reload re-importing this module.
      const cached = desktopClients.get(credentials.account);
      if (cached) return cached;
      const client = sdk.createClient({
        auth: new sdk.DesktopAuth(credentials.account),
        integrationName: "Alchemy",
        integrationVersion: packageJson.version,
      });
      desktopClients.set(credentials.account, client);
      // A failed authorization is not cached, so the next load asks again.
      client.catch(() => desktopClients.delete(credentials.account));
      return client;
    },
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
