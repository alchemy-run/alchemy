import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { OutboxLive } from "./fixtures/effect-bindings/src/outbox.live.ts";
import { Outbox } from "./fixtures/effect-bindings/src/outbox.ts";
import { EFFECT_BINDINGS_FIXTURE_DIR, testName } from "./support.ts";

const { test } = Test.make({ providers: Layer.mergeAll(Convex.providers(), AWS.providers()) });

const app = (name: string) =>
  Effect.gen(function* () {
    const project = yield* Convex.Project("BindingsApp", { name }).pipe(RemovalPolicy.destroy());
    const deployment = yield* Convex.Deployment("Deployment", { project, type: "preview" });
    yield* Convex.Functions("Functions", {
      deployment,
      rootDir: EFFECT_BINDINGS_FIXTURE_DIR,
      functions: OutboxLive,
    });
    const queue = yield* Outbox;
    return { url: deployment.url, queueUrl: queue.queueUrl };
  });

test.provider(
  "an action sends to the SQS queue its constructor binds, with Config read at deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = yield* testName("action-bindings");
      // The deploying machine's value, which the constructor reads with Config.
      const { url, queueUrl } = yield* stack.deploy(
        app(name).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ OUTBOX_TAG: "outbox" }),
          ),
        ),
      );

      const client = new ConvexHttpClient(url);
      // IAM takes a few seconds before a new key and role can be used.
      const messageId = yield* Effect.tryPromise(() =>
        client.action(anyApi.outbox!.publish!, { body: "from convex" }),
      ).pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }));
      expect(typeof messageId).toBe("string");

      const received = yield* SQS.receiveMessage({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 5,
        MaxNumberOfMessages: 10,
      }).pipe(
        Effect.map((result) => result.Messages ?? []),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (messages) => messages.length > 0,
          times: 10,
        }),
      );
      expect(received.map((message) => message.Body)).toContain("outbox: from convex");

      yield* stack.destroy();
      // The user Alchemy created for the deployment is gone with the stack.
      const users = yield* IAM.listUsers({});
      expect((users.Users ?? []).some((user) => user.UserName.includes("FunctionsUser"))).toBe(
        false,
      );
    }),
  {
    tags: ["provider:convex", "provider:convex:functions", "provider:aws", "live"],
    timeout: 600_000,
  },
);
