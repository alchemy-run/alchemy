import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete ai gateway with default props", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const gateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("DefaultGateway", {
          id: "alchemy-test-ai-gateway-default",
        });
      }),
    );

    expect(gateway.gatewayId).toEqual("alchemy-test-ai-gateway-default");
    expect(gateway.cacheInvalidateOnUpdate).toEqual(false);
    expect(gateway.cacheTtl).toEqual(null);
    expect(gateway.collectLogs).toEqual(true);
    expect(gateway.rateLimitingInterval).toEqual(null);
    expect(gateway.rateLimitingLimit).toEqual(null);
    expect(gateway.rateLimitingTechnique).toEqual("fixed");

    const actualGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: gateway.gatewayId,
    });
    expect(actualGateway.id).toEqual(gateway.gatewayId);

    yield* stack.destroy();

    yield* waitForGatewayToBeDeleted(gateway.gatewayId, accountId);
  }).pipe(logLevel),
);

test.provider("create, update, delete ai gateway", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const gateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("TestGateway", {
          id: "alchemy-test-ai-gateway",
          cacheTtl: 60,
          collectLogs: true,
          rateLimitingInterval: 60,
          rateLimitingLimit: 100,
          rateLimitingTechnique: "fixed",
        });
      }),
    );

    const actualGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: gateway.gatewayId,
    });
    expect(actualGateway.id).toEqual(gateway.gatewayId);
    expect(actualGateway.cacheTtl).toEqual(60);
    expect(actualGateway.rateLimitingLimit).toEqual(100);

    const updatedGateway = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AiGateway("TestGateway", {
          id: "alchemy-test-ai-gateway",
          cacheTtl: 120,
          collectLogs: true,
          rateLimitingInterval: 120,
          rateLimitingLimit: 200,
          rateLimitingTechnique: "sliding",
        });
      }),
    );

    const actualUpdatedGateway = yield* aiGateway.getAiGateway({
      accountId,
      id: updatedGateway.gatewayId,
    });
    expect(actualUpdatedGateway.cacheTtl).toEqual(120);
    expect(actualUpdatedGateway.rateLimitingInterval).toEqual(120);
    expect(actualUpdatedGateway.rateLimitingLimit).toEqual(200);
    expect(actualUpdatedGateway.rateLimitingTechnique).toEqual("sliding");

    yield* stack.destroy();

    yield* waitForGatewayToBeDeleted(gateway.gatewayId, accountId);
  }).pipe(logLevel),
);

const waitForGatewayToBeDeleted = Effect.fn(function* (
  gatewayId: string,
  accountId: string,
) {
  yield* aiGateway
    .getAiGateway({
      accountId,
      id: gatewayId,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new GatewayStillExists())),
      Effect.retry({
        while: (e): e is GatewayStillExists => e instanceof GatewayStillExists,
        schedule: Schedule.exponential(100),
      }),
      Effect.catchTag("GatewayNotFound", () => Effect.void),
    );
});

class GatewayStillExists extends Data.TaggedError("GatewayStillExists") {}
