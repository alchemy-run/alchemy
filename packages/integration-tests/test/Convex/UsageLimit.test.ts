import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deployments from "@distilled.cloud/convex/deployment";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { onDeployment, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const options = { timeout: 180_000 };

const limit = { metric: "functionCalls", window: "month", limitType: "warning" } as const;

const app = (name: string, props: Omit<Convex.UsageLimitProps, "deployment">) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    const usage = yield* Convex.UsageLimit("Limit", { deployment, ...props });
    return { deployment, usage };
  });

const limits = (url: string) =>
  onDeployment(url, deployments.listUsageLimits({})).pipe(Effect.map((r) => r.usageLimits));

test.provider(
  "creates, updates and deletes a limit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("limit-sync");
      const first = yield* stack.deploy(app(name, { ...limit, limit: 1000 }));
      const live = yield* limits(first.deployment.url);
      expect(live.map((item) => [item.id, item.limit, item.enabled])).toEqual([
        [first.usage.usageLimitId, 1000, true],
      ]);

      const second = yield* stack.deploy(app(name, { ...limit, limit: 2000, enabled: false }));
      expect(second.usage.usageLimitId).toBe(first.usage.usageLimitId);
      const updated = yield* limits(first.deployment.url);
      expect(updated.map((item) => [item.limit, item.enabled])).toEqual([[2000, false]]);

      const third = yield* stack.deploy(
        app(name, { limit: 5, metric: "functionCalls", window: "day", limitType: "warning" }),
      );
      const moved = yield* limits(third.deployment.url);
      expect(moved.map((item) => [item.window, item.limit])).toEqual([["day", 5]]);

      yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          yield* Convex.Deployment("Deployment", { project, type: "preview" });
        }),
      );
      expect(yield* limits(first.deployment.url)).toEqual([]);

      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "refuses a limit it doesn't own, and adopts it when allowed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("limit-unowned");
      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          return yield* Convex.Deployment("Deployment", { project, type: "preview" });
        }),
      );
      const foreign = yield* onDeployment(
        base.url,
        deployments.createUsageLimit({ ...limit, limit: 7, enabled: true }),
      );

      const refused = yield* stack
        .deploy(app(name, { ...limit, limit: 9 }).pipe(adopt(false)))
        .pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(name, { ...limit, limit: 9 }).pipe(adopt(true)));
      expect(adopted.usage.usageLimitId).toBe(foreign.usageLimit.id);
      expect((yield* limits(base.url)).map((item) => item.limit)).toEqual([9]);

      yield* stack.destroy();
    }),
  options,
);

test.provider(
  "delete tolerates a deployment that is already gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("limit-gone");
      yield* stack.deploy(app(name, { ...limit, limit: 1 }));
      const destroyed = yield* stack.destroy().pipe(Effect.result);
      expect(Result.isSuccess(destroyed)).toBe(true);
    }),
  options,
);
