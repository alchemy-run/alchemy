import {
  ConflictingWebhookEndpoint,
  makeWebhookDispatcher,
  reserveWebhookPath,
} from "@/Serverless/Webhook.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

describe("webhook acknowledgement", () => {
  it.effect("waits for every subscriber before acknowledging", () =>
    Effect.gen(function* () {
      const dispatcher = yield* makeWebhookDispatcher<string>();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const observed: string[] = [];
      yield* dispatcher.subscribe((id) =>
        Effect.sync(() => {
          observed.push(`first:${id}`);
        }),
      );
      yield* dispatcher.subscribe((id) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          observed.push(`second:${id}`);
        }),
      );
      let acknowledged = false;
      const fiber = yield* dispatcher.dispatch("delivery-1").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            acknowledged = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      expect(acknowledged).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fiber)).status).toBe(202);
      expect(observed).toEqual(["first:delivery-1", "second:delivery-1"]);
    }),
  );

  it.effect(
    "a failed subscriber does not cancel successful siblings or acknowledge the delivery",
    () =>
      Effect.gen(function* () {
        const dispatcher = yield* makeWebhookDispatcher<string>();
        let completed = 0;
        yield* dispatcher.subscribe(() => Effect.fail(new Error("retry")));
        yield* dispatcher.subscribe(() =>
          Effect.yieldNow.pipe(
            Effect.andThen(
              Effect.sync(() => {
                completed++;
              }),
            ),
          ),
        );
        expect((yield* dispatcher.dispatch("same-id")).status).toBe(503);
        expect(completed).toBe(1);
      }),
  );

  it.effect(
    "retries invoke successful subscribers again until all succeed",
    () =>
      Effect.gen(function* () {
        const dispatcher = yield* makeWebhookDispatcher<string>();
        const delivered: string[] = [];
        let attempts = 0;
        yield* dispatcher.subscribe((id) =>
          Effect.sync(() => {
            delivered.push(id);
          }),
        );
        yield* dispatcher.subscribe(() =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(new Error("transient"))
              : Effect.void,
          ),
        );
        expect((yield* dispatcher.dispatch("same-id")).status).toBe(503);
        expect((yield* dispatcher.dispatch("same-id")).status).toBe(202);
        expect(delivered).toEqual(["same-id", "same-id"]);
        expect(attempts).toBe(2);
      }),
  );

  it.effect(
    "defects and thrown subscriber callbacks return a failure response",
    () =>
      Effect.gen(function* () {
        for (const subscriber of [
          () => Effect.die("defect"),
          () => {
            throw new Error("callback");
          },
        ]) {
          const dispatcher = yield* makeWebhookDispatcher<string>();
          yield* dispatcher.subscribe(subscriber);
          const response = yield* dispatcher.dispatch("delivery");
          expect(response.status).toBe(503);
          expect(yield* Effect.promise(() => response.text())).toBe(
            "webhook processing failed",
          );
        }
      }),
  );

  it.effect(
    "a stalled subscriber times out without acknowledgement and is interrupted",
    () =>
      Effect.gen(function* () {
        const dispatcher = yield* makeWebhookDispatcher<string>();
        let interrupted = false;
        yield* dispatcher.subscribe(() =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        );
        const fiber = yield* dispatcher
          .dispatch("delivery")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("31 seconds");
        expect((yield* Fiber.join(fiber)).status).toBe(503);
        expect(interrupted).toBe(true);
      }),
  );

  it.effect(
    "supports an acknowledgement status and ignored event selections",
    () =>
      Effect.gen(function* () {
        const dispatcher = yield* makeWebhookDispatcher<string>({
          successStatus: 200,
        });
        let calls = 0;
        yield* dispatcher.subscribe((event) =>
          event === "push"
            ? Effect.sync(() => {
                calls++;
              })
            : Effect.void,
        );
        expect((yield* dispatcher.dispatch("issue")).status).toBe(200);
        expect(calls).toBe(0);
        expect((yield* dispatcher.dispatch("push")).status).toBe(200);
        expect(calls).toBe(1);
      }),
  );

  it.effect(
    "rejects conflicting receivers on one host without rejecting other paths or hosts",
    () =>
      Effect.gen(function* () {
        const host = {};
        yield* reserveWebhookPath(host, "/hook");
        yield* reserveWebhookPath(host, "/other");
        yield* reserveWebhookPath({}, "/hook");
        const exit = yield* reserveWebhookPath(host, "/hook").pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toBeInstanceOf(
            ConflictingWebhookEndpoint,
          );
      }),
  );
});
