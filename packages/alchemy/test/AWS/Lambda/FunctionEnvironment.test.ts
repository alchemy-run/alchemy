import { resolveFunctionRuntimeEnv } from "@/AWS/Lambda/Function.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

it.effect("serializes runtime identity for packaged Lambdas", () =>
  resolveFunctionRuntimeEnv.pipe(
    Effect.tap((environment) =>
      Effect.sync(() => {
        expect(environment).toEqual({
          ALCHEMY_AWS_ACCOUNT_ID: "123456789012",
          ALCHEMY_AWS_SERVICE_ENDPOINTS: JSON.stringify({
            ses: "http://ses.local",
          }),
          ALCHEMY_STACK_NAME: "example",
          ALCHEMY_STAGE: "production",
          ALCHEMY_PHASE: "runtime",
        });
      }),
    ),
    Effect.provideService(
      AWSEnvironment,
      Effect.succeed({
        accountId: "123456789012",
        region: "us-east-1",
        credentials: Effect.die("not used"),
        serviceEndpoints: { ses: "http://ses.local" },
      }),
    ),
    Effect.provideService(Stack, {
      name: "example",
      stage: "production",
      resources: {},
      bindings: {},
      actions: {},
    } satisfies Omit<StackSpec, "output">),
  ),
);
