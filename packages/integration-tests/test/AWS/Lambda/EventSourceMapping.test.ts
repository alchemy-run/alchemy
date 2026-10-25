import * as AWS from "@alchemy.run/aws";
import { EventSourceMapping } from "@alchemy.run/aws/Lambda";
import { expect } from "@alchemy.run/test";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Provider from "alchemy/Provider";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import EventSourceMappingFunctionLive, {
  EventSourceMappingFunction,
} from "./fixtures/event-source-mapping-handler.ts";
import {
  EventSourceMappingReplaceFunction,
  FifoQueueLive,
  StandardQueueLive,
} from "./fixtures/event-source-mapping-replace-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// minimal Lambda Function + SQS Queue + EventSourceMapping (wired via the
// `consumeQueueMessages(queue, ...)` event source), resolve the provider from
// context with the typed `Provider.findProvider(EventSourceMapping)`, call
// `list()`, and assert the deployed mapping appears in the exhaustively
// paginated result.
test.provider(
  "list enumerates the deployed event source mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        EventSourceMappingFunction.pipe(Effect.provide(EventSourceMappingFunctionLive)),
      );

      const provider = yield* Provider.findProvider(EventSourceMapping);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((m) => m.functionArn === fn.functionArn)).toBe(true);

      const mine = all.find((m) => m.functionArn === fn.functionArn)!;
      expect(mine.uuid).toBeTruthy();
      expect(mine.eventSourceMappingArn).toContain("event-source-mapping");
      expect(mine.state).toBeTruthy();

      yield* stack.destroy();

      // Out-of-band proof the destroy removed both the mapping and the host
      // function from the cloud (bounded retry for delete propagation).
      yield* Lambda.getEventSourceMapping({ UUID: mine.uuid }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`Event source mapping ${mine.uuid} still exists`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
        }),
      );
      yield* Lambda.getFunction({ FunctionName: fn.functionName }).pipe(
        Effect.flatMap(() => Effect.fail(new Error(`Function ${fn.functionName} still exists`))),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
        }),
      );
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 240_000,
  },
);

// Switching the queue between standard and FIFO replaces it in the same deploy
// that updates the mapping, so the queue's ARN is unresolved when the mapping
// is diffed. AWS cannot move a mapping to another source, so the mapping must
// be replaced rather than updated in place.
test.provider(
  "replaces the mapping when its queue is replaced",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const mappingsOf = (functionName: string) =>
        Lambda.listEventSourceMappings({ FunctionName: functionName }).pipe(
          Effect.map((page) => page.EventSourceMappings ?? []),
        );

      const standard = yield* stack.deploy(
        EventSourceMappingReplaceFunction.pipe(Effect.provide(StandardQueueLive)),
      );
      const [before] = yield* mappingsOf(standard.functionName);
      expect(before?.EventSourceArn?.endsWith(".fifo")).toBe(false);

      const fifo = yield* stack.deploy(
        EventSourceMappingReplaceFunction.pipe(Effect.provide(FifoQueueLive)),
      );
      const after = yield* mappingsOf(fifo.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.EventSourceArn?.endsWith(".fifo")).toBe(true);
      expect(after[0]!.UUID).not.toEqual(before!.UUID);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 240_000,
  },
);
