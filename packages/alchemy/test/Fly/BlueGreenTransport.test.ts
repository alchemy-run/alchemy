import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { assertAppGone } from "./fixtures/bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

test.provider(
  "F02 S07 harness forwards real Fly responses, loses completed responses and cuts connections",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("Site"));
      const proxy = yield* transportProxy();
      yield* Effect.sync(() => {
        endpoint = proxy.url;
      });
      try {
        const request = machines
          .getApp({ app_name: app.appName })
          .pipe(Retry.none);
        const forwarded = yield* request;
        expect(forwarded.name).toBe(app.appName);
        expect(
          proxy.events.some(
            (event) => event.stage === "forwarded" && event.status === 200,
          ),
        ).toBe(true);
        yield* Effect.sync(() =>
          proxy.arm({
            match: (event) => event.path.endsWith(`/apps/${app.appName}`),
            action: "drop-response",
            remaining: 1,
          }),
        );
        const dropped = yield* request.pipe(Effect.result);
        // The HTTP runtime may transparently replay an idempotent GET after a socket reset.
        if (Result.isFailure(dropped))
          expect(dropped.failure._tag).toBe("HttpClientError");
        else expect(dropped.success.name).toBe(app.appName);
        expect(
          proxy.events.filter(
            (event) => event.stage === "dropped" && event.status === 200,
          ),
        ).toHaveLength(1);
        yield* Effect.sync(() =>
          proxy.arm({
            match: () => true,
            action: "cut-request",
            remaining: Infinity,
          }),
        );
        const cut = yield* request.pipe(Effect.result);
        expect(Result.isFailure(cut)).toBe(true);
        const cutEvent = proxy.events.find((event) => event.stage === "cut")!;
        expect(
          proxy.events.some(
            (event) =>
              event.sequence === cutEvent.sequence &&
              event.stage === "completed",
          ),
        ).toBe(false);
        yield* Effect.sync(() => {
          proxy.clear();
          proxy.arm({
            match: () => true,
            action: "hold-response",
            remaining: 1,
          });
        });
        const child = yield* request.pipe(Effect.forkScoped);
        const held = yield* proxy.wait((event) => event.stage === "held");
        expect(held.status).toBe(200);
        yield* Effect.sync(proxy.release);
        expect(
          (yield* Fiber.join(child).pipe(Effect.timeout("10 seconds"))).name,
        ).toBe(app.appName);
        expect((yield* request).name).toBe(app.appName);
      } finally {
        yield* Effect.sync(() => {
          endpoint = undefined;
          proxy.clear();
          proxy.release();
        });
      }
      yield* stack.destroy();
      yield* assertAppGone(app.appName);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          endpoint = undefined;
        }),
      ),
    ),
  { timeout: 180_000 },
);
