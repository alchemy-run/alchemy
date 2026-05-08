import * as Cloudflare from "@/Cloudflare";
import { RuntimeContext } from "@/RuntimeContext";
import type { FunctionListener } from "@/Serverless/Function";
import { Self } from "@/Self";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({ providers: Layer.empty });

test(
  "routes scheduled events that match the cron expression",
  Effect.gen(function* () {
    const listeners: FunctionListener[] = [];
    const handled: number[] = [];

    yield* Cloudflare.cron("0 12 * * *")
      .subscribe((controller) =>
        Effect.sync(() => {
          handled.push(controller.scheduledTime);
        }),
      )
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Cloudflare.CronEventSourceLive,
            Layer.succeed(Cloudflare.CronEventSourcePolicy, () => Effect.void),
            Layer.succeed(RuntimeContext, {
              Type: "Cloudflare.Worker",
              id: "CronWorker",
              env: {},
              get: () => Effect.void,
              set: () => Effect.succeed(""),
              listen: (listener: FunctionListener) =>
                Effect.sync(() => {
                  listeners.push(listener);
                }),
            }),
          ),
        ),
        Effect.provideService(Self, {
          Type: "Cloudflare.Worker",
          LogicalId: "CronWorker",
        }),
      );

    const event = {
      kind: "Cloudflare.Workers.WorkerEvent",
      type: "scheduled",
      input: { cron: "0 12 * * *", scheduledTime: 123 },
      env: {},
      context: {},
    };
    const ignored = {
      ...event,
      input: { cron: "0 0 * * *", scheduledTime: 456 },
    };

    yield* runListener(listeners[0]!, ignored);
    yield* runListener(listeners[0]!, event);

    expect(handled).toEqual([123]);
  }),
);

const runListener = (listener: FunctionListener, event: unknown) => {
  const result = listener(event);
  return Effect.isEffect(result) ? result : Effect.void;
};
