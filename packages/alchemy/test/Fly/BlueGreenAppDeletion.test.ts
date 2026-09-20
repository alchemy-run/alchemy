import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Fly from "@/Fly";
import { DestroyError } from "@/Apply";
import { AppDeletionAmbiguous } from "@/Fly/App";
import * as Test from "@/Test/Alchemy";
import { assert, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { engineActor } from "./fixtures/actors.ts";
import { assertAppGone } from "./fixtures/bluegreen.ts";
import { transportProxy } from "./fixtures/transport.ts";

const { test } = Test.make({ providers: Fly.providers() });
const ambiguousTitle =
  "F11 ambiguous name-addressed App deletion does not blindly retry";

test.provider(
  ambiguousTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("Site"));
      const proxy = yield* transportProxy();
      const actor = yield* engineActor(
        stack,
        ambiguousTitle,
        "test/Fly/BlueGreenAppDeletion.test.ts",
        proxy.url,
      );
      yield* Effect.sync(() => {
        proxy.arm({
          match: (event) =>
            event.method === "DELETE" &&
            event.path === `/v1/apps/${app.appName}`,
          action: "drop-response",
          remaining: Infinity,
        });
      });
      const result = yield* actor
        .destroy()
        .pipe(Effect.timeout("45 seconds"), Effect.result);
      assert(Result.isFailure(result));
      assert(result.failure instanceof DestroyError);
      expect(result.failure.blocked).toEqual([]);
      expect(result.failure.failures).toHaveLength(1);
      const failure = result.failure.failures[0]!;
      expect(failure.logicalId).toBe("Site");
      expect(failure.resourceType).toBe("Fly.App");
      const cause = Cause.findError(failure.cause);
      assert(Result.isSuccess(cause));
      assert(cause.success instanceof AppDeletionAmbiguous);
      expect(cause.success).toMatchObject({
        _tag: "Fly.AppDeletionAmbiguous",
        appName: app.appName,
        evidence: "HttpClientError",
      });
      const attempts = proxy.events.filter(
        (event) =>
          event.stage === "request" &&
          event.method === "DELETE" &&
          event.path === `/v1/apps/${app.appName}`,
      );
      expect(attempts).toHaveLength(1);
      expect(
        proxy.events.some(
          (event) =>
            event.stage === "dropped" &&
            event.status! >= 200 &&
            event.status! < 300,
        ),
      ).toBe(true);
      yield* Effect.sync(proxy.clear);
      yield* assertAppGone(app.appName);
      // An explicit cleanup after observing absence is not an automatic transport retry.
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { timeout: 180_000 },
);

const successorTitle =
  "F11 ambiguous App deletion cannot retry into an independently recreated same-name successor";
test.provider(
  successorTitle,
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("Site"));
      expect(app.orgSlug).toBeDefined();
      const proxy = yield* transportProxy();
      yield* Effect.sync(() =>
        proxy.arm({
          match: (event) =>
            event.method === "DELETE" &&
            event.path === `/v1/apps/${app.appName}`,
          action: "hold-response",
          remaining: 1,
        }),
      );
      yield* Effect.gen(function* () {
        const actor = yield* engineActor(
          stack,
          successorTitle,
          "test/Fly/BlueGreenAppDeletion.test.ts",
          proxy.url,
        );
        const deletion = yield* actor
          .destroy()
          .pipe(Effect.scoped, Effect.result, Effect.forkScoped);
        yield* proxy.wait(
          (event) =>
            event.stage === "held" &&
            event.status! >= 200 &&
            event.status! < 300,
        );
        yield* assertAppGone(app.appName);
        // This independent API actor demonstrates the missing cross-process tombstone, not safe automatic recreation.
        yield* machines
          .createApp({ name: app.appName, org_slug: app.orgSlug! })
          .pipe(Retry.none, Effect.provide(FetchHttpClient.layer));
        yield* Effect.gen(function* () {
          const successor = yield* machines
            .createMachine({
              app_name: app.appName,
              name: "successor-sentinel",
              region: "iad",
              config: { image: "nginx:alpine" },
            })
            .pipe(Effect.provide(FetchHttpClient.layer));
          yield* Effect.sync(proxy.dropHeld);
          const result = yield* Fiber.join(deletion).pipe(
            Effect.timeout("45 seconds"),
          );
          expect(
            proxy.events.filter(
              (event) =>
                event.stage === "request" &&
                event.method === "DELETE" &&
                event.path === `/v1/apps/${app.appName}`,
            ),
          ).toHaveLength(1);
          assert(Result.isFailure(result));
          assert(result.failure instanceof DestroyError);
          expect(result.failure.blocked).toEqual([]);
          expect(result.failure.failures).toHaveLength(1);
          const failure = result.failure.failures[0]!;
          expect(failure.logicalId).toBe("Site");
          expect(failure.resourceType).toBe("Fly.App");
          const cause = Cause.findError(failure.cause);
          assert(Result.isSuccess(cause));
          assert(cause.success instanceof AppDeletionAmbiguous);
          expect(cause.success).toMatchObject({
            _tag: "Fly.AppDeletionAmbiguous",
            appName: app.appName,
            evidence: "HttpClientError",
          });
          const surviving = yield* machines
            .getMachine({ app_name: app.appName, machine_id: successor.id! })
            .pipe(Effect.provide(FetchHttpClient.layer));
          expect(surviving.id).toBe(successor.id);
          expect(surviving.name).toBe("successor-sentinel");
        }).pipe(
          Effect.ensuring(
            // Only the independent fixture owner removes its successor; the uncertain engine is not retried against it.
            machines.deleteApp({ app_name: app.appName }).pipe(
              Retry.none,
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.provide(FetchHttpClient.layer),
              Effect.orDie,
            ),
          ),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            proxy.clear();
            proxy.dropHeld();
          }),
        ),
        Effect.scoped,
      );
      yield* assertAppGone(app.appName);
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { timeout: 300_000 },
);
