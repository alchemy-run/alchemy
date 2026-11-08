import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as queue from "@distilled.cloud/modal/queue";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Modal.providers() });

const exists = (id: string) =>
  queue.queueGetById({ queueId: id }).pipe(
    Effect.map(() => true),
    Effect.catchTag("QueueNotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, keep on redeploy, replace on rename, and delete a queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Queue("Queue", {});
        }),
      );
      yield* expectFound(Modal.Queue.lookup({ name: first.name }), first);
      expect(yield* exists(first.queueId)).toBe(true);

      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Queue("Queue", {});
        }),
      );
      expect(again.queueId).toBe(first.queueId);

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Queue("Queue", { name: `${first.name.slice(0, 61)}-b` });
        }),
      );
      expect(renamed.queueId).not.toBe(first.queueId);
      expect(yield* exists(first.queueId)).toBe(false);

      yield* stack.destroy();
      expect(yield* exists(renamed.queueId)).toBe(false);
    }),
  { tags: ["provider:modal", "provider:modal:queue", "live"], timeout: 120_000 },
);
