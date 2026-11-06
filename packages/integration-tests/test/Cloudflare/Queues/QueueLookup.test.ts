import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:queues", "live"];

// Sends through each producer binding; a binding to a queue that doesn't
// exist fails the send.
const callerScript = `export default {
  async fetch(request, env) {
    await env.BY_NAME.send({ via: "name" });
    await env.BY_ID.send({ via: "id" });
    return new Response("sent through both lookups");
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "QueueLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const queue = yield* Cloudflare.Queues.Queue("lookup-target");
    return {
      name: queue.queueName.as<string>(),
      queueId: queue.queueId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up queue binds by name and by id, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name, queueId } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Queues.Queue.lookup({ name });
        const caller = yield* Cloudflare.Worker("queue-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { BY_NAME: byName, BY_ID: Cloudflare.Queues.Queue.lookup({ queueId }) },
        });
        return { url: caller.url.as<string>(), queueId: byName.queueId };
      });
      const out = yield* stack.deploy(program);
      expect(out.queueId).toBe(queueId);

      yield* expectUrlContains(out.url, "sent through both lookups", {
        label: "queue lookup caller",
      });

      // A lookup re-resolves to the same queue, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["queue-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the queue alone.
      yield* stack.destroy();
      const survivor = yield* queues.getQueue({ accountId, queueId });
      expect(survivor.queueName).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing queue fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("queue-lookup-missing", {
            script: callerScript,
            env: { BY_NAME: Cloudflare.Queues.Queue.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a queue this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Queues.Queue("lookup-managed");
      const { queueName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("queue-lookup-managed", {
              script: callerScript,
              env: { BY_NAME: Cloudflare.Queues.Queue.lookup({ name: queueName }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
