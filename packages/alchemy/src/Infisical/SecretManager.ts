import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  SecretManager as SecretManagerService,
  SecretManagerError,
  type SecretManagerLayer,
  type SecretManagerResolveOptions,
} from "../SecretManager.ts";

const managerName = "Infisical";
const defaultApiUrl = "https://app.infisical.com";

/** An Infisical secret set selected for an Alchemy stack instance. */
export interface SecretSet {
  /** ID of the Infisical project containing the secrets. */
  readonly projectId: string;
  /** Slug of the Infisical environment containing the secrets. */
  readonly environment: string;
  /**
   * Folder path to load.
   * @default "/"
   */
  readonly secretPath?: string;
  /**
   * Load secrets from child folders.
   * @default false
   */
  readonly recursive?: boolean;
  /**
   * Expand Infisical secret references.
   * @default true
   */
  readonly expandSecretReferences?: boolean;
  /**
   * Prefer personal overrides over shared secrets.
   * @default false
   */
  readonly includePersonalOverrides?: boolean;
  /**
   * Include secrets imported into the selected folder.
   * @default true
   */
  readonly includeImports?: boolean;
}

/** Map an Alchemy stack and stage to an Infisical secret set. */
export type SecretsSelector = (
  context: SecretManagerResolveOptions,
) => SecretSet;

type Fetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => ReturnType<typeof globalThis.fetch>;

interface SecretValue {
  readonly secretKey: string;
  readonly secretValue: string;
}

interface SecretsPayload {
  readonly secrets: readonly SecretValue[];
  readonly imports?: readonly {
    readonly secrets: readonly SecretValue[];
  }[];
}

const failure = (message: string, cause?: unknown) =>
  new SecretManagerError({
    manager: managerName,
    message,
    cause,
  });

const isSecretValue = (value: unknown): value is SecretValue =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  "secretKey" in value &&
  typeof value.secretKey === "string" &&
  "secretValue" in value &&
  typeof value.secretValue === "string";

const isSecretsPayload = (value: unknown): value is SecretsPayload =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  "secrets" in value &&
  Array.isArray(value.secrets) &&
  value.secrets.every(isSecretValue) &&
  (!("imports" in value) ||
    value.imports === undefined ||
    (Array.isArray(value.imports) &&
      value.imports.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          "secrets" in item &&
          Array.isArray(item.secrets) &&
          item.secrets.every(isSecretValue),
      )));

const isSecretSet = (value: unknown): value is SecretSet =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  "projectId" in value &&
  typeof value.projectId === "string" &&
  value.projectId.trim().length > 0 &&
  "environment" in value &&
  typeof value.environment === "string" &&
  value.environment.trim().length > 0 &&
  (!("secretPath" in value) ||
    value.secretPath === undefined ||
    (typeof value.secretPath === "string" &&
      value.secretPath.startsWith("/"))) &&
  (!("recursive" in value) ||
    value.recursive === undefined ||
    typeof value.recursive === "boolean") &&
  (!("expandSecretReferences" in value) ||
    value.expandSecretReferences === undefined ||
    typeof value.expandSecretReferences === "boolean") &&
  (!("includePersonalOverrides" in value) ||
    value.includePersonalOverrides === undefined ||
    typeof value.includePersonalOverrides === "boolean") &&
  (!("includeImports" in value) ||
    value.includeImports === undefined ||
    typeof value.includeImports === "boolean");

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((cause) =>
      failure(`Infisical could not read ${name} from configuration.`, cause),
    ),
  );

const optionalSecret = (name: string) =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((cause) =>
      failure(`Infisical could not read ${name} from configuration.`, cause),
    ),
  );

const endpoint = (apiUrl: string, path: string) => {
  const url = new URL(apiUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Infisical API URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Infisical API URL must not contain credentials.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  return url;
};

const readApiUrl = Effect.fn("Infisical.readApiUrl")(function* () {
  const configured = yield* optionalString("INFISICAL_API_URL");
  const apiUrl =
    configured === undefined || configured === "" ? defaultApiUrl : configured;
  return yield* Effect.try({
    try: () => endpoint(apiUrl, "/"),
    catch: (cause) =>
      failure(
        "Infisical is configured with an invalid INFISICAL_API_URL.",
        cause,
      ),
  }).pipe(Effect.map((url) => url.toString()));
});

const readAccessToken = Effect.fn("Infisical.readAccessToken")(function* (
  apiUrl: string,
  fetch: Fetch,
) {
  const configuredToken = yield* optionalSecret("INFISICAL_TOKEN");
  if (configuredToken !== undefined) {
    const token = Redacted.value(configuredToken);
    if (token !== "") return token;
  }

  const clientId = yield* optionalString("INFISICAL_UNIVERSAL_AUTH_CLIENT_ID");
  const configuredClientSecret = yield* optionalSecret(
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  );
  const clientSecret =
    configuredClientSecret === undefined
      ? undefined
      : Redacted.value(configuredClientSecret);
  if (
    clientId === undefined ||
    clientId === "" ||
    clientSecret === undefined ||
    clientSecret === ""
  ) {
    return yield* Effect.fail(
      failure(
        "Infisical is configured for this stack but neither INFISICAL_TOKEN nor complete Universal Auth credentials are set.",
      ),
    );
  }

  const organizationSlug = yield* optionalString(
    "INFISICAL_AUTH_ORGANIZATION_SLUG",
  );
  const url = endpoint(apiUrl, "/api/v1/auth/universal-auth/login");
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          ...(organizationSlug === undefined || organizationSlug === ""
            ? {}
            : { organizationSlug }),
        }),
        redirect: "error",
        signal,
      }),
    catch: (cause) => failure("Infisical Universal Auth login failed.", cause),
  });
  if (!response.ok) {
    return yield* Effect.fail(
      failure(
        `Infisical Universal Auth login failed (HTTP ${response.status}).`,
        new Error(
          `Infisical Universal Auth failed with HTTP ${response.status} ${response.statusText}.`,
        ),
      ),
    );
  }

  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    // JSON parser errors can contain plaintext excerpts of the access token.
    catch: () => failure("Infisical Universal Auth returned invalid JSON."),
  });
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("accessToken" in payload) ||
    typeof payload.accessToken !== "string" ||
    payload.accessToken === ""
  ) {
    return yield* Effect.fail(
      failure("Infisical Universal Auth returned an invalid token payload."),
    );
  }
  return payload.accessToken;
});

const makeResolve = (selector: SecretsSelector, fetch: Fetch) =>
  Effect.fn("Infisical.secrets.resolve")(function* ({
    stack,
    stage,
  }: SecretManagerResolveOptions) {
    const selection = yield* Effect.try({
      try: () => selector({ stack, stage }),
      catch: (cause) =>
        failure(
          `Infisical could not select a secret set for stack '${stack}'.`,
          cause,
        ),
    });
    if (!isSecretSet(selection)) {
      return yield* Effect.fail(
        failure(
          `Infisical selected an invalid secret set for stack '${stack}'.`,
        ),
      );
    }

    const apiUrl = yield* readApiUrl();
    const token = yield* readAccessToken(apiUrl, fetch);
    const url = endpoint(apiUrl, "/api/v4/secrets");
    url.searchParams.set("projectId", selection.projectId);
    url.searchParams.set("environment", selection.environment);
    url.searchParams.set("secretPath", selection.secretPath ?? "/");
    url.searchParams.set(
      "expandSecretReferences",
      String(selection.expandSecretReferences ?? true),
    );
    url.searchParams.set("recursive", String(selection.recursive ?? false));
    url.searchParams.set(
      "includePersonalOverrides",
      String(selection.includePersonalOverrides ?? false),
    );

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
          },
          redirect: "error",
          signal,
        }),
      catch: (cause) =>
        failure(
          `Infisical could not download secrets for stack '${stack}'.`,
          cause,
        ),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        failure(
          `Infisical could not download secrets for stack '${stack}' (HTTP ${response.status}).`,
          new Error(
            `Infisical secrets download failed with HTTP ${response.status} ${response.statusText}.`,
          ),
        ),
      );
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      // JSON parser errors can contain plaintext excerpts of the secrets.
      catch: () =>
        failure(`Infisical returned invalid JSON for stack '${stack}'.`),
    });
    if (!isSecretsPayload(payload)) {
      return yield* Effect.fail(
        failure(
          `Infisical returned an invalid secrets payload for stack '${stack}'.`,
        ),
      );
    }

    const values: Record<string, string> = {};
    if (selection.includeImports ?? true) {
      for (const imported of payload.imports ?? []) {
        for (const secret of imported.secrets) {
          values[secret.secretKey] = secret.secretValue;
        }
      }
    }
    for (const secret of payload.secrets) {
      values[secret.secretKey] = secret.secretValue;
    }
    return ConfigProvider.fromUnknown(values);
  });

/** @internal */
export const makeSecretManager = (
  selector: SecretsSelector,
  fetch: Fetch = globalThis.fetch,
): SecretManagerLayer =>
  Layer.succeed(SecretManagerService, {
    name: managerName,
    resolve: makeResolve(selector, fetch),
  });

/**
 * Load an Alchemy stack's configuration from Infisical.
 *
 * The adapter maps each stack and stage to an Infisical project, environment,
 * and folder, then exposes the selected values through Effect `Config`.
 * Alchemy composes those values over its default configuration provider.
 *
 * Authentication uses `INFISICAL_TOKEN` when set. Otherwise the adapter logs
 * in with `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and
 * `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`. Set `INFISICAL_API_URL` for
 * Infisical EU Cloud or a self-hosted instance.
 *
 * ### Configure a Stack
 * **Example:** Map Alchemy stacks and stages to Infisical
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Infisical from "alchemy/Infisical";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "app",
 *   {
 *     secrets: Infisical.secrets(({ stack, stage }) => ({
 *       projectId: "00000000-0000-0000-0000-000000000000",
 *       environment: stage ?? "dev",
 *       secretPath: `/${stack}`,
 *     })),
 *   },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *     return { configured: apiKey !== undefined };
 *   }),
 * );
 * ```
 *
 * @layer
 * @provides SecretManager
 * @product Infisical
 */
export const secrets = (selector: SecretsSelector): SecretManagerLayer =>
  makeSecretManager(selector);
