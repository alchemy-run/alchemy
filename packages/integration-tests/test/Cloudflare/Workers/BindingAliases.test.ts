import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";
import AliasConsumer from "./fixtures/binding-aliases/consumer.ts";
import DefaultConsumer from "./fixtures/binding-aliases/default-consumer.ts";
import { Events, Media } from "./fixtures/binding-aliases/resources.ts";
import AliasTarget from "./fixtures/binding-aliases/target.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: false });

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

class ResourceStillExists extends Data.TaggedError("ResourceStillExists") {}

const untilDeleted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flatMap(() => Effect.fail(new ResourceStillExists())),
    Effect.retry({
      while: (error): error is ResourceStillExists => error instanceof ResourceStillExists,
      schedule: Schedule.spaced("2 seconds"),
      times: 20,
    }),
  );

const program = () =>
  Effect.gen(function* () {
    const bucket = yield* Media;
    const queue = yield* Events;
    const target = yield* AliasTarget;
    const aliased = yield* AliasConsumer;
    const defaulted = yield* DefaultConsumer;
    return {
      bucketName: bucket.bucketName,
      queueId: queue.queueId,
      queueName: queue.queueName,
      bucketLogicalId: bucket.LogicalId,
      queueLogicalId: queue.LogicalId,
      targetLogicalId: target.LogicalId,
      targetName: target.workerName,
      aliasName: aliased.workerName,
      defaultName: defaulted.workerName,
      aliasUrl: aliased.url.as<string>(),
      defaultUrl: defaulted.url.as<string>(),
    };
  });

/** Cloudflare account-level deploy: ownership, bindings, data plane, no-ops and cleanup. */
test.provider(
  "explicit env aliases and default bindings converge on real Cloudflare Workers",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      yield* Effect.gen(function* () {
        const resourceIds = [
          "AliasMedia",
          "AliasEvents",
          "AliasTarget",
          "AliasConsumer",
          "DefaultConsumer",
        ];
        const createPlan = yield* stack.plan(program());
        for (const logicalId of resourceIds) {
          const planned = Object.values(createPlan.resources).find(
            (entry) => entry.resource.LogicalId === logicalId,
          );
          expect(planned?.action).toBe("create");
        }

        const deployed = yield* stack.deploy(program());
        const client = yield* HttpClient.HttpClient;
        const request = (base: string, path: string) =>
          client.get(`${base}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.succeed(response)
                : Effect.fail(new WorkerNotReady({ status: response.status })),
            ),
            Effect.retry({
              while: (error): error is WorkerNotReady => error instanceof WorkerNotReady,
              schedule: Schedule.spaced("3 seconds"),
              times: 15,
            }),
            Effect.flatMap((response) => response.text),
          );

        // Inspect the real uploaded Worker settings, not just the local plan
        // or the WorkerEnvironment projection exposed by our test route.
        const aliasSettings = yield* workers
          .getScriptScriptAndVersionSetting({
            accountId,
            scriptName: deployed.aliasName,
          })
          .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }));
        const defaultSettings = yield* workers
          .getScriptScriptAndVersionSetting({
            accountId,
            scriptName: deployed.defaultName,
          })
          .pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }));

        expect(aliasSettings.bindings).toContainEqual(
          expect.objectContaining({ type: "r2_bucket", name: "MEDIA" }),
        );
        expect(aliasSettings.bindings).toContainEqual(
          expect.objectContaining({ type: "queue", name: "EVENTS" }),
        );
        expect(aliasSettings.bindings).toContainEqual(
          expect.objectContaining({ type: "service", name: "AUTH", service: deployed.targetName }),
        );
        const aliasNames = aliasSettings.bindings?.map((binding) => binding.name);
        for (const unexpected of [
          deployed.bucketLogicalId,
          deployed.queueLogicalId,
          deployed.targetLogicalId,
        ]) {
          expect(aliasNames).not.toContain(unexpected);
        }
        const defaultNames = defaultSettings.bindings?.map((binding) => binding.name);
        for (const expected of [
          deployed.bucketLogicalId,
          deployed.queueLogicalId,
          deployed.targetLogicalId,
        ]) {
          expect(defaultNames).toContain(expected);
        }

        // Both resources are resolved from the real Cloudflare API, not
        // inferred from Alchemy's persisted output values.
        const actualBucket = yield* r2.getBucket({
          accountId,
          bucketName: deployed.bucketName,
        });
        const actualQueue = yield* queues.getQueue({ accountId, queueId: deployed.queueId });
        expect(actualBucket.name).toEqual(deployed.bucketName);
        expect(actualQueue.queueId).toEqual(deployed.queueId);

        expect(yield* request(deployed.aliasUrl, "/r2")).toBe("aliased content:aliased content");
        expect(yield* request(deployed.aliasUrl, "/queue")).toBe("queue sent");
        expect(yield* request(deployed.aliasUrl, "/rpc")).toBe("hello alice from alias target");
        expect(JSON.parse(yield* request(deployed.aliasUrl, "/env"))).toEqual({
          aliased: true,
          extra: [],
        });
        expect(yield* request(deployed.defaultUrl, "/r2")).toBe("default content");
        expect(yield* request(deployed.defaultUrl, "/queue")).toBe("default queue sent");
        expect(yield* request(deployed.defaultUrl, "/rpc")).toBe("hello bob from alias target");
        expect(JSON.parse(yield* request(deployed.defaultUrl, "/env"))).toEqual({
          defaults: true,
          aliased: [],
        });

        // Idempotency is a real plan/apply contract: matching resource props
        // must be no-ops, including all three physical Worker scripts.
        const stable = yield* stack.plan(program());
        for (const logicalId of resourceIds) {
          const planned = Object.values(stable.resources).find(
            (entry) => entry.resource.LogicalId === logicalId,
          );
          expect(planned?.action).toBe("noop");
        }
        yield* stack.deploy(program());

        // Normal application-level deletion leaves the bucket empty before
        // the provider owns its final destruction.
        expect(yield* request(deployed.aliasUrl, "/r2-cleanup")).toBe("alias object deleted");
        expect(yield* request(deployed.defaultUrl, "/r2-cleanup")).toBe("default object deleted");

        yield* stack.destroy();

        // Check deletion independently of Alchemy State. Avoid account-wide
        // cleanup on a personal account that owns other resources.
        for (const workerName of [deployed.aliasName, deployed.defaultName, deployed.targetName]) {
          yield* waitForWorkerToBeDeleted(workerName, accountId);
        }
        yield* untilDeleted(r2.getBucket({ accountId, bucketName: deployed.bucketName })).pipe(
          Effect.catchTag("NoSuchBucket", () => Effect.void),
        );
        yield* untilDeleted(queues.getQueue({ accountId, queueId: deployed.queueId })).pipe(
          Effect.catchTag("QueueNotFound", () => Effect.void),
        );
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.orDie)));
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:r2",
      "provider:cloudflare:queue",
      "live",
    ],
    timeout: 540_000,
  },
);
