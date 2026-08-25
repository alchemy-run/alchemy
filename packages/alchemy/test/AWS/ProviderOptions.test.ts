import {
  AWS_ENDPOINT_URL,
  AWS_SERVICE_ENDPOINTS,
  AWS_SERVICE_ENDPOINTS_ENV_VAR,
  AWSEnvironment,
  Runtime as AwsRuntime,
} from "@/AWS/Environment.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

describe("AWS runtime environment", () => {
  it.effect("decodes global and service-specific endpoints", () =>
    Effect.gen(function* () {
      expect(yield* AWS_ENDPOINT_URL).toBe("http://global.local");
      expect(yield* AWS_SERVICE_ENDPOINTS).toEqual({
        ses: "http://ses.local",
        sqs: "http://sqs.local",
      });
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            AWS_ENDPOINT_URL: "http://global.local",
            [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify({
              ses: "http://ses.local",
              sqs: "http://sqs.local",
            }),
          },
        }),
      ),
    ),
  );

  it.effect(
    "accepts structured service endpoints from the runtime provider",
    () =>
      AWS_SERVICE_ENDPOINTS.pipe(
        Effect.tap((endpoints) =>
          Effect.sync(() =>
            expect(endpoints).toEqual({
              ses: "http://ses.local",
            }),
          ),
        ),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.make((path) =>
            Effect.succeed(
              path[0] === AWS_SERVICE_ENDPOINTS_ENV_VAR
                ? ({
                    _tag: "Value",
                    value: { ses: "http://ses.local" },
                  } as unknown as ConfigProvider.Node)
                : undefined,
            ),
          ),
        ),
      ),
  );

  it.effect("rejects malformed service endpoint values", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(AWS_SERVICE_ENDPOINTS);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe(
          "AWS::Environment::InvalidServiceEndpoints",
        );
      }
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: { [AWS_SERVICE_ENDPOINTS_ENV_VAR]: '{"sqs":""}' },
        }),
      ),
    ),
  );

  it.effect("reconstructs the runtime AWS environment", () =>
    Effect.gen(function* () {
      const environment = yield* AWSEnvironment.current;
      expect(environment.accountId).toBe("123456789012");
      expect(environment.region).toBe("us-east-1");
      expect(environment.endpoint).toBe("http://floci:4566");
      expect(environment.serviceEndpoints).toEqual({
        ses: "http://ses.local",
      });
    }).pipe(
      Effect.provide(
        AwsRuntime.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                Credentials,
                Effect.succeed({
                  accessKeyId: Redacted.make("access"),
                  secretAccessKey: Redacted.make("secret"),
                  sessionToken: undefined,
                  region: "us-east-1",
                }),
              ),
              Layer.succeed(Region, Effect.succeed("us-east-1")),
            ),
          ),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  ALCHEMY_AWS_ACCOUNT_ID: "123456789012",
                  AWS_ENDPOINT_URL: "http://floci:4566",
                  [AWS_SERVICE_ENDPOINTS_ENV_VAR]: JSON.stringify({
                    ses: "http://ses.local",
                  }),
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
