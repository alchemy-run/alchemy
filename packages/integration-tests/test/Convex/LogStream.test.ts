import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as deployments from "@distilled.cloud/convex/deployment";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { onDeployment, testName } from "./support.ts";

const { test } = Test.make({ providers: Convex.providers() });
const pro = !!process.env.CONVEX_TEST_PRO;
const options = {
  tags: ["provider:convex", "provider:convex:logstream", "live"],
  timeout: 180_000,
};

const base = (name: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("App", { name }).pipe(RemovalPolicy.destroy());
    return yield* Convex.Deployment("Deployment", { project, type: "preview" });
  });

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
        expect(refused.failure).toMatchObject({ _tag: "LogStreamingNotEnabled" });
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
      const list = () => onDeployment(first.deployment.url, deployments.listIntegrations({}));
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

test.provider.skipIf(!pro)(
  "refuses a stream it doesn't own, and adopts it with its signing secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("logs-unowned");
      const deployment = yield* stack.deploy(base(name));
      const foreign = yield* onDeployment(
        deployment.url,
        deployments.createIntegration({
          body: { logStreamType: "webhook", url: "https://example.com/foreign", format: "json" },
        }),
      );

      const refused = yield* stack
        .deploy(app(name, "https://example.com/mine").pipe(adopt(false)))
        .pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(name, "https://example.com/mine").pipe(adopt(true)));
      expect(adopted.stream.logStreamId).toBe(foreign.id);
      expect("hmacSecret" in foreign).toBe(true);
      if ("hmacSecret" in foreign) {
        expect(Redacted.value(adopted.stream.hmacSecret!)).toBe(foreign.hmacSecret);
      }
      const streams = yield* onDeployment(deployment.url, deployments.listIntegrations({}));
      expect(streams.map((stream) => ("url" in stream ? stream.url : undefined))).toEqual([
        "https://example.com/mine",
      ]);

      yield* stack.destroy();
    }),
  options,
);

test.provider.skipIf(!pro)(
  "destroy tolerates a stream that is already gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("logs-gone");
      const { deployment, stream } = yield* stack.deploy(app(name, "https://example.com/gone"));
      yield* onDeployment(
        deployment.url,
        deployments.deleteIntegration({ id: stream.logStreamId }),
      );

      // Drop the stream from the stack while its deployment stays, so its
      // delete runs against a deployment that no longer has it.
      const removed = yield* stack.deploy(base(name)).pipe(Effect.result);
      expect(Result.isSuccess(removed)).toBe(true);
      yield* stack.destroy();
    }),
  options,
);
