/**
 * A Lambda function's secret environment: every `Redacted` env value (a
 * user's `env`, or a binding's) is kept out of the function's configuration,
 * where `lambda:GetFunctionConfiguration` returns it in plain text. The
 * values go into one SSM SecureString parameter of the function's own, and
 * the function names it, pinned to its version, in {@link SECRET_ENV}; the
 * bootstrap loads it into `process.env` before any user code runs.
 *
 * @internal
 */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import * as ssm from "@distilled.cloud/aws/ssm";
import { envString } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * The env var naming the function's secret parameter: `name:version`, or the
 * parameter's ARN with `:version` when the function may run outside the
 * parameter's Region.
 */
export const SECRET_ENV = "ALCHEMY_SECRET_ENV";

/** The SSM parameter holding a function's secret environment. */
export const secretEnvParameterName = (functionName: string) => `/alchemy/lambda/${functionName}`;

/** The SSM parameter holding a Web Function's secret environment. */
export const webSecretEnvParameterName = (functionName: string) =>
  `/alchemy/lambda-web/${functionName}`;

/** A parameter's ARN, from its name (which starts with `/`). */
export const parameterArn = (partition: string, region: string, accountId: string, name: string) =>
  `arn:${partition}:ssm:${region}:${accountId}:parameter${name}`;

/** Split an env record into the plain values and the `Redacted` ones. */
export const splitSecretEnv = (env: Record<string, unknown>) => {
  const plain: Record<string, unknown> = {};
  const secret: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (Redacted.isRedacted(value)) {
      const text = envString(value);
      if (text !== undefined) secret[key] = text;
    } else {
      plain[key] = value;
    }
  }
  return { plain, secret };
};

/**
 * Converge the function's secret parameter on `secret`: write it only when
 * its value differs, so an unchanged deploy keeps the version (and the
 * function's configuration) as it is. Without secrets, the parameter is
 * removed. Returns the `name:version` the function reads, if any.
 */
export const syncSecretEnv = Effect.fn(function* (
  name: string,
  secret: Record<string, string>,
  description: string,
) {
  if (Object.keys(secret).length === 0) {
    yield* deleteSecretEnv(name);
    return undefined;
  }
  const value = JSON.stringify(
    Object.fromEntries(Object.entries(secret).sort(([a], [b]) => a.localeCompare(b))),
  );
  const observed = yield* ssm.getParameter({ Name: name, WithDecryption: true }).pipe(
    Effect.map((result) => result.Parameter),
    Effect.catchTag("ParameterNotFound", () => Effect.undefined),
  );
  const observedValue =
    observed?.Value === undefined || !Redacted.isRedacted(observed.Value)
      ? observed?.Value
      : Redacted.value(observed.Value);
  if (observedValue === value && observed?.Version !== undefined) {
    return `${name}:${observed.Version}`;
  }
  const { Version } = yield* ssm.putParameter({
    Name: name,
    Type: "SecureString",
    Value: Redacted.make(value),
    Overwrite: true,
    // Up to 4 KB stays in the free standard tier; past it, advanced.
    Tier: "Intelligent-Tiering",
    Description: description,
  });
  return `${name}:${Version}`;
});

/** Remove a function's secret parameter, by name; absent is fine. */
export const deleteSecretEnv = (name: string) =>
  ssm.deleteParameter({ Name: name }).pipe(
    Effect.asVoid,
    Effect.catchTag("ParameterNotFound", () => Effect.void),
  );

/** The statement letting the function's role read its secret parameter. */
export const secretEnvStatement = (arn: string) => ({
  Sid: "AlchemySecretEnv",
  Effect: "Allow" as const,
  Action: ["ssm:GetParameter"],
  Resource: [arn],
});

/**
 * At a function's start: read its secret parameter, if it has one, into
 * `process.env`.
 */
export const loadSecretEnv = Effect.gen(function* () {
  // oxlint-disable-next-line effecttsgo/process-env-in-effect -- the function's own env, written by its provider, read before Config exists
  const ref = process.env[SECRET_ENV];
  if (ref === undefined || ref === "") return;
  // An ARN names the parameter's Region, which may not be the function's.
  const marker = ref.indexOf(":parameter/");
  const { Parameter } = yield* ref.startsWith("arn:") && marker !== -1
    ? ssm.getParameter({
        Name: ref.slice(marker + ":parameter".length),
        WithDecryption: true,
        region: ref.split(":")[3]!,
      })
    : ssm.getParameter({ Name: ref, WithDecryption: true });
  const text = Parameter?.Value;
  const values = JSON.parse(
    text === undefined ? "{}" : Redacted.isRedacted(text) ? Redacted.value(text) : text,
  ) as Record<string, string>;
  yield* Effect.sync(() => Object.assign(process.env, values));
});

/**
 * {@link loadSecretEnv} as a Layer with its own AWS client, for a bootstrap
 * to build before anything reads the environment: the runtime
 * `ConfigProvider` snapshots `process.env` when it builds.
 */
export const SecretEnvLive = Layer.effectDiscard(loadSecretEnv).pipe(
  Layer.provide(
    Layer.mergeAll(
      Credentials.fromEnv(),
      Region.fromEnv(),
      Endpoint.fromEnv(),
      FetchHttpClient.layer,
    ),
  ),
);
