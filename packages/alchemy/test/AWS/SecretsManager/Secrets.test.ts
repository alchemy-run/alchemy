import * as Credentials from "@distilled.cloud/aws/Credentials";
import {
  makeCredentialsLayer,
  makeSecretManager,
  type SecretsSelector,
} from "@/AWS/SecretsManager/Secrets.ts";
import { SecretManager as SecretManagerService } from "@/SecretManager.ts";
import { expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

type LoadSecret = NonNullable<Parameters<typeof makeSecretManager>[1]>;

const read = (provider: ConfigProvider.ConfigProvider, name: string) =>
  Config.string(name).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );

const resolve = (
  selector: SecretsSelector,
  loadSecret: LoadSecret,
  fallback: ConfigProvider.ConfigProvider = ConfigProvider.fromUnknown({}),
  stack = "payments",
  stage: string | undefined = "preview",
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeSecretManager(selector, loadSecret));
    return yield* Effect.provideService(
      Context.get(context, SecretManagerService).resolve({ stack, stage }),
      ConfigProvider.ConfigProvider,
      fallback,
    );
  });

it("exports the adapter from AWS.SecretsManager", async () => {
  const AWS = await import("alchemy/AWS");
  const service = await import("alchemy/AWS/SecretsManager");
  expect(AWS.SecretsManager.secrets).toBeTypeOf("function");
  expect(service.secrets).toBeTypeOf("function");
});

it.effect("maps stack and stage to an AWS secret set", () =>
  Effect.gen(function* () {
    let selected: Parameters<LoadSecret>[0] | undefined;
    const provider = yield* resolve(
      ({ stack, stage }) => ({
        secretId: `${stack}/${stage}`,
        region: "eu-west-1",
        versionId: "version-id",
        versionStage: "AWSPREVIOUS",
      }),
      (selection) => {
        selected = selection;
        return Effect.succeed({
          SecretString: Redacted.make(
            JSON.stringify({ API_KEY: "aws-secret", SHARED: "aws" }),
          ),
        });
      },
      ConfigProvider.fromUnknown({ FALLBACK_ONLY: "fallback" }),
    );

    expect(selected).toEqual({
      secretId: "payments/preview",
      region: "eu-west-1",
      versionId: "version-id",
      versionStage: "AWSPREVIOUS",
    });
    expect(yield* read(provider, "API_KEY")).toBe("aws-secret");
    expect(yield* read(provider, "SHARED")).toBe("aws");
    const fallbackOnly = yield* Config.option(
      Config.string("FALLBACK_ONLY"),
    ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
    expect(fallbackOnly._tag).toBe("None");
  }),
);

it.effect("accepts a secret name directly", () =>
  Effect.gen(function* () {
    let selected: Parameters<LoadSecret>[0] | undefined;
    yield* resolve(
      ({ stack, stage }) => `${stack}/${stage ?? "dev"}`,
      (selection) => {
        selected = selection;
        return Effect.succeed({ SecretString: JSON.stringify({}) });
      },
    );
    expect(selected).toEqual({ secretId: "payments/preview" });
  }),
);

it.effect("builds static credentials from the default ConfigProvider", () =>
  Effect.gen(function* () {
    const layer = yield* makeCredentialsLayer("us-west-2");
    const context = yield* Layer.build(layer);
    const credentials = yield* Context.get(context, Credentials.Credentials);
    expect(Redacted.value(credentials.accessKeyId)).toBe("access-key");
    expect(Redacted.value(credentials.secretAccessKey)).toBe("secret-key");
    expect(Redacted.value(credentials.sessionToken!)).toBe("session-token");
    expect(credentials.region).toBe("us-west-2");
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
        AWS_SESSION_TOKEN: "session-token",
      }),
    ),
  ),
);

it.effect("rejects incomplete static credentials", () =>
  makeCredentialsLayer("us-east-1").pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ AWS_ACCESS_KEY_ID: "access-key" }),
    ),
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.manager).toBe("AWS Secrets Manager");
        expect(error.message).toContain("incomplete static AWS credentials");
      }),
    ),
  ),
);

it.effect("maps AWS loading failures to SecretManagerError", () =>
  resolve(
    () => "payments/preview",
    () => Effect.fail(new Error("unsafe AWS response")),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error._tag).toBe("SecretManagerError");
        expect(error.manager).toBe("AWS Secrets Manager");
        expect(error.message).toContain("could not load configuration");
        expect(error.message).not.toContain("unsafe AWS response");
      }),
    ),
  ),
);

it.effect("rejects binary secrets", () =>
  resolve(
    () => "payments/preview",
    () => Effect.succeed({ SecretBinary: Redacted.make(new Uint8Array([1])) }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("Binary secrets are not supported");
      }),
    ),
  ),
);

it.effect("rejects malformed JSON without exposing the secret", () => {
  const secret = "not-json-do-not-expose";
  return resolve(
    () => "payments/preview",
    () => Effect.succeed({ SecretString: Redacted.make(secret) }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("invalid JSON");
        expect(error.message).not.toContain(secret);
      }),
    ),
  );
});

it.effect("rejects JSON values that are not strings", () =>
  resolve(
    () => "payments/preview",
    () => Effect.succeed({ SecretString: JSON.stringify({ PORT: 8080 }) }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("JSON object with string values");
      }),
    ),
  ),
);

it.effect("maps selector failures to SecretManagerError", () =>
  resolve(
    () => {
      throw new Error("unsafe selector detail");
    },
    () => Effect.succeed({ SecretString: "{}" }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("could not select");
        expect(error.message).not.toContain("unsafe selector detail");
      }),
    ),
  ),
);

it.effect("rejects invalid secret selections", () =>
  resolve(
    () => ({ secretId: "", versionStage: "" }),
    () => Effect.succeed({ SecretString: "{}" }),
  ).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.message).toContain("selected an invalid secret");
      }),
    ),
  ),
);
