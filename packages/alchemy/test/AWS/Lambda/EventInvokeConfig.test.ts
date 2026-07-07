import * as AWS from "@/AWS";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const timeoutHandlerPath = new URL("./timeout-handler.ts", import.meta.url)
  .pathname;

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, list, delete event invoke config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = ({
        maximumRetryAttempts,
        maximumEventAgeInSeconds,
      }: {
        maximumRetryAttempts?: number;
        maximumEventAgeInSeconds?: number;
      }) =>
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("FailureQueue", {
            visibilityTimeout: 30,
          });

          const fn = yield* AWS.Lambda.Function("AsyncFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            url: false,
          });

          yield* fn.bind("AllowEventInvokeDestination", {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:SendMessage"],
                Resource: [queue.queueArn],
              },
            ],
          });

          const config = yield* AWS.Lambda.EventInvokeConfig("AsyncConfig", {
            functionName: fn.functionName,
            maximumRetryAttempts,
            maximumEventAgeInSeconds,
            destinationConfig: {
              OnFailure: {
                Destination: queue.queueArn,
              },
            },
          });

          return { fn, queue, config };
        });

      const created = yield* stack.deploy(
        program({
          maximumRetryAttempts: 0,
          maximumEventAgeInSeconds: 60,
        }),
      );

      expect(created.config.maximumRetryAttempts).toBe(0);
      expect(created.config.maximumEventAgeInSeconds).toBe(60);
      expect(created.config.destinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );

      const liveCreated = yield* getEventInvokeConfig(created.fn.functionName, {
        maximumRetryAttempts: 0,
        maximumEventAgeInSeconds: 60,
        onFailureDestination: created.queue.queueArn,
      });
      expect(liveCreated.MaximumRetryAttempts).toBe(0);
      expect(liveCreated.MaximumEventAgeInSeconds).toBe(60);
      expect(liveCreated.DestinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );

      const updated = yield* stack.deploy(
        program({
          maximumRetryAttempts: 1,
          maximumEventAgeInSeconds: 120,
        }),
      );

      expect(updated.config.functionArn).toBe(created.config.functionArn);
      expect(updated.config.maximumRetryAttempts).toBe(1);
      expect(updated.config.maximumEventAgeInSeconds).toBe(120);
      expect(updated.config.destinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );

      const liveUpdated = yield* getEventInvokeConfig(updated.fn.functionName, {
        maximumRetryAttempts: 1,
        maximumEventAgeInSeconds: 120,
        onFailureDestination: created.queue.queueArn,
      });
      expect(liveUpdated.MaximumRetryAttempts).toBe(1);
      expect(liveUpdated.MaximumEventAgeInSeconds).toBe(120);
      expect(liveUpdated.DestinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );

      const reset = yield* stack.deploy(program({}));

      expect(reset.config.functionArn).toBe(created.config.functionArn);
      expect(reset.config.maximumRetryAttempts).toBe(2);
      expect(reset.config.maximumEventAgeInSeconds).toBe(21_600);
      expect(reset.config.destinationConfig?.OnFailure?.Destination).toBe(
        created.queue.queueArn,
      );

      const provider = yield* Provider.findProvider(
        AWS.Lambda.EventInvokeConfig,
      );
      const configs = yield* provider.list();
      expect(
        configs.some(
          (config) =>
            config.functionName === reset.fn.functionName &&
            config.maximumRetryAttempts === 2 &&
            config.maximumEventAgeInSeconds === 21_600 &&
            config.destinationConfig?.OnFailure?.Destination ===
              reset.queue.queueArn,
        ),
      ).toBe(true);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const getEventInvokeConfig = Effect.fn(function* (
  functionName: string,
  expected: {
    maximumRetryAttempts: number;
    maximumEventAgeInSeconds: number;
    onFailureDestination: string;
  },
) {
  return yield* Lambda.getFunctionEventInvokeConfig({
    FunctionName: functionName,
  }).pipe(
    Effect.filterOrFail(
      (config) =>
        config.MaximumRetryAttempts === expected.maximumRetryAttempts &&
        config.MaximumEventAgeInSeconds === expected.maximumEventAgeInSeconds &&
        config.DestinationConfig?.OnFailure?.Destination ===
          expected.onFailureDestination,
      () => new Error("Event invoke config update has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});
