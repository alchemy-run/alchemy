import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import * as SVC from "@distilled.cloud/aws/secrets-manager";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  SecretManager as SecretManagerService,
  SecretManagerError,
  type SecretManagerLayer,
  type SecretManagerResolveOptions,
} from "../../SecretManager.ts";

const managerName = "AWS Secrets Manager";

/** An AWS Secrets Manager secret selected for an Alchemy stack instance. */
export interface SecretSet {
  /** Name or full ARN of the secret containing the configuration object. */
  readonly secretId: string;
  /** AWS region containing the secret. */
  readonly region?: string;
  /** Retrieve a specific secret version ID. */
  readonly versionId?: string;
  /**
   * Retrieve a specific staging label, such as `AWSPREVIOUS`. AWS uses
   * `AWSCURRENT` when neither a version ID nor stage is provided.
   */
  readonly versionStage?: string;
}

/** Map an Alchemy stack and stage to one AWS Secrets Manager secret. */
export type SecretsSelector = (
  context: SecretManagerResolveOptions,
) => string | SecretSet;

type NormalizedSecretSet = Required<Pick<SecretSet, "secretId">> &
  Omit<SecretSet, "secretId">;

type LoadSecret = (
  selection: NormalizedSecretSet,
) => Effect.Effect<SVC.GetSecretValueResponse, unknown>;

const failure = (message: string, cause?: unknown) =>
  new SecretManagerError({
    manager: managerName,
    message,
    cause,
  });

const optionalString = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((cause) =>
      failure(
        `AWS Secrets Manager could not read ${name} from configuration.`,
        cause,
      ),
    ),
  );

const optionalSecret = (name: string) =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError((cause) =>
      failure(
        `AWS Secrets Manager could not read ${name} from configuration.`,
        cause,
      ),
    ),
  );

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const optionalNonEmpty = (value: unknown) =>
  value === undefined || nonEmpty(value);

const normalizeSelection = (
  value: string | SecretSet,
): NormalizedSecretSet | undefined => {
  if (typeof value === "string") {
    return nonEmpty(value) ? { secretId: value } : undefined;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !nonEmpty(value.secretId) ||
    !optionalNonEmpty(value.region) ||
    !optionalNonEmpty(value.versionId) ||
    !optionalNonEmpty(value.versionStage)
  ) {
    return undefined;
  }
  return value;
};

/** @internal */
export const makeCredentialsLayer = Effect.fn("AWS.SecretsManager.credentials")(
  function* (region: string | undefined) {
    const accessKeyId = yield* optionalString("AWS_ACCESS_KEY_ID");
    const configuredSecretAccessKey = yield* optionalSecret(
      "AWS_SECRET_ACCESS_KEY",
    );
    const secretAccessKey =
      configuredSecretAccessKey === undefined
        ? undefined
        : Redacted.value(configuredSecretAccessKey);
    const configuredSessionToken = yield* optionalSecret("AWS_SESSION_TOKEN");
    const sessionToken =
      configuredSessionToken === undefined
        ? undefined
        : Redacted.value(configuredSessionToken);

    const hasAccessKey = nonEmpty(accessKeyId);
    const hasSecretKey = nonEmpty(secretAccessKey);
    if (hasAccessKey !== hasSecretKey) {
      return yield* Effect.fail(
        failure(
          "AWS Secrets Manager found incomplete static AWS credentials. Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither to use the default credential chain.",
        ),
      );
    }
    if (hasAccessKey && hasSecretKey) {
      return Credentials.fromCredentials(
        {
          accessKeyId,
          secretAccessKey,
          ...(nonEmpty(sessionToken) ? { sessionToken } : {}),
        },
        region,
      );
    }
    return Credentials.fromChain();
  },
);

const defaultLoadSecret: LoadSecret = Effect.fn(
  "AWS.SecretsManager.loadSecret",
)(function* (selection) {
  const configuredRegion = yield* optionalString("AWS_REGION");
  const configuredDefaultRegion = yield* optionalString("AWS_DEFAULT_REGION");
  const region =
    selection.region ?? configuredRegion ?? configuredDefaultRegion;
  const configuredEndpoint = yield* optionalString("AWS_ENDPOINT_URL");
  const credentials = yield* makeCredentialsLayer(region);

  let request = SVC.getSecretValue({
    SecretId: selection.secretId,
    ...(selection.versionId === undefined
      ? {}
      : { VersionId: selection.versionId }),
    ...(selection.versionStage === undefined
      ? {}
      : { VersionStage: selection.versionStage }),
  }).pipe(Effect.provide(credentials), Effect.provide(FetchHttpClient.layer));
  if (region !== undefined) {
    request = request.pipe(
      Effect.provideService(Region.Region, Effect.succeed(region)),
    );
  }
  if (nonEmpty(configuredEndpoint)) {
    request = request.pipe(
      Effect.provideService(
        Endpoint.Endpoint,
        Effect.succeed(configuredEndpoint),
      ),
    );
  }
  return yield* request;
});

const isSecretRecord = (value: unknown): value is Record<string, string> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

const secretString = (value: SVC.GetSecretValueResponse["SecretString"]) =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

const makeResolve = (selector: SecretsSelector, loadSecret: LoadSecret) =>
  Effect.fn("AWS.SecretsManager.secrets.resolve")(function* ({
    stack,
    stage,
  }: SecretManagerResolveOptions) {
    const selected = yield* Effect.try({
      try: () => selector({ stack, stage }),
      catch: (cause) =>
        failure(
          `AWS Secrets Manager could not select a secret for stack '${stack}'.`,
          cause,
        ),
    });
    const selection = normalizeSelection(selected);
    if (selection === undefined) {
      return yield* Effect.fail(
        failure(
          `AWS Secrets Manager selected an invalid secret for stack '${stack}'.`,
        ),
      );
    }

    const response = yield* loadSecret(selection).pipe(
      Effect.mapError((cause) =>
        cause instanceof SecretManagerError
          ? cause
          : failure(
              `AWS Secrets Manager could not load configuration for stack '${stack}'.`,
              cause,
            ),
      ),
    );
    const contents = secretString(response.SecretString);
    if (contents === undefined) {
      return yield* Effect.fail(
        failure(
          `AWS Secrets Manager returned no SecretString for stack '${stack}'. Binary secrets are not supported as configuration providers.`,
        ),
      );
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (cause) =>
        failure(
          `AWS Secrets Manager returned invalid JSON for stack '${stack}'.`,
          cause,
        ),
    });
    if (!isSecretRecord(parsed)) {
      return yield* Effect.fail(
        failure(
          `AWS Secrets Manager returned an invalid configuration object for stack '${stack}'. Expected a JSON object with string values.`,
        ),
      );
    }
    return ConfigProvider.fromUnknown(parsed);
  });

/** @internal */
export const makeSecretManager = (
  selector: SecretsSelector,
  loadSecret: LoadSecret = defaultLoadSecret,
): SecretManagerLayer =>
  Layer.succeed(SecretManagerService, {
    name: managerName,
    resolve: makeResolve(selector, loadSecret),
  });

/**
 * Load an Alchemy stack's configuration from AWS Secrets Manager.
 *
 * The selected AWS secret must contain a `SecretString` encoded as a JSON
 * object whose values are strings. Alchemy exposes that object through Effect
 * `Config` and composes it over the default configuration provider.
 *
 * Static AWS credentials can come from Alchemy's default configuration. When
 * they are absent, the adapter uses the standard Node.js AWS credential chain,
 * including shared profiles, IAM Identity Center, and workload credentials.
 *
 * ### Configure a Stack
 * **Example:** Map stacks and stages to AWS secrets
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "app",
 *   {
 *     secrets: AWS.SecretsManager.secrets(({ stack, stage }) => ({
 *       secretId: `${stack}/${stage ?? "dev"}`,
 *       region: "us-east-1",
 *     })),
 *   },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *     return { configured: apiKey !== undefined };
 *   }),
 * );
 * ```
 *
 * **Example:** Select a secret name directly
 * ```typescript
 * secrets: AWS.SecretsManager.secrets(({ stack, stage }) =>
 *   `${stack}/${stage ?? "dev"}`,
 * );
 * ```
 *
 * @layer
 * @provides SecretManager
 * @product AWS Secrets Manager
 */
export const secrets = (selector: SecretsSelector): SecretManagerLayer =>
  makeSecretManager(selector);
