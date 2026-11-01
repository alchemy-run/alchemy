import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deployments from "@distilled.cloud/convex/deployment";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { onDeployment, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const pro = !!process.env.CONVEX_TEST_PRO;
const options = { timeout: 180_000 };

const app = (name: string, url: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    const stream = yield* Convex.LogStream("Logs", {
      deployment,
      config: { logStreamType: "webhook", url, format: "json" },
    });
    return { deployment, stream };
  });

test.provider.skipIf(pro)(
  "needs the Professional plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("logs-plan");
      const refused = yield* stack
        .deploy(app(name, "https://example.com/convex"))
        .pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) {
        expect((refused.failure as { _tag: string })._tag).toBe("LogStreamingNotEnabled");
      }
      yield* stack.destroy();
    }),
  options,
);

test.provider.skipIf(!pro)(
  "creates, updates and deletes a webhook stream",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("logs-sync");
      const first = yield* stack.deploy(app(name, "https://example.com/one"));
      expect(Redacted.isRedacted(first.stream.hmacSecret)).toBe(true);
      const list = () => onDeployment(first.deployment.url, deployments.listLogStreams({}));
      expect(yield* list()).toHaveLength(1);

      const second = yield* stack.deploy(app(name, "https://example.com/two"));
      expect(second.stream.logStreamId).toBe(first.stream.logStreamId);

      yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
          yield* Convex.Deployment("Deployment", { project, type: "preview" });
        }),
      );
      expect(yield* list()).toEqual([]);
      yield* stack.destroy();
    }),
  options,
);
