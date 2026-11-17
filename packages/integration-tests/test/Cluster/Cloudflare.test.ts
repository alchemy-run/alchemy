import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { conformanceTests, get, waitForReady } from "./conformance.ts";
import Front from "./fixtures/cloudflare/front.ts";
import { Lives } from "./fixtures/cloudflare/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = {
  providers: Layer.mergeAll(Cloudflare.providers(), Cluster.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterCloudflare", import.meta.url);

let baseUrl = "";

/**
 * The stack, with `generation` served to the Config a hosted class reads:
 * deploying another generation gives the pool's Worker a new version.
 */
const deploy = (generation: string) =>
  Effect.gen(function* () {
    const ambient = yield* ConfigProvider.ConfigProvider;
    return yield* sharedStack.deploy(
      Effect.gen(function* () {
        const front = yield* Front;
        return { url: front.url };
      }).pipe(
        Effect.provide(Lives),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ CLUSTER_GENERATION: generation }),
            ambient,
          ),
        ),
      ),
    );
  });

// The Effect Cluster conformance cases, against entities, workflows,
// singletons and crons on Durable Objects, called from another Worker
// through the gateway.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Cloudflare (Durable Objects)",
  { tags: ["provider:cluster", "provider:cloudflare", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* deploy("1");
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl);
      }),
      { timeout: 600_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), { timeout: 300_000 });

    const options = { timeout: 120_000, tags: ["live"] };

    conformanceTests(test as never, {
      baseUrl: () => baseUrl,
      kind: "live",
      external: false,
      // An object's alarm rings at the message's time.
      deliverWithinMillis: 5_000,
    });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });

    test(
      "a persisted message too large for the object's storage is refused, and the entity carries on",
      Effect.gen(function* () {
        // workerd's SQLite holds two megabytes in a value.
        expect(yield* get(`${baseUrl}/note/cf-large/3000000`)).toEqual({ tag: "PersistenceError" });
        expect(yield* get(`${baseUrl}/note/cf-large/10`)).toEqual({ value: 10 });
      }),
      options,
    );

    test(
      "every reader of a persisted stream gets every chunk, while it runs and after",
      Effect.gen(function* () {
        const url = `${baseUrl}/countdown/cf-readers/op-1`;
        const [first, second] = yield* Effect.all(
          [get(url), Effect.delay(get(url), "400 millis")],
          { concurrency: 2 },
        );
        expect(first.values).toEqual([1, 2, 3, 4, 5]);
        expect(second.values).toEqual([1, 2, 3, 4, 5]);
        // Once it has finished, the object answers from what it stored.
        const later = yield* get(url);
        expect(later.values).toEqual([1, 2, 3, 4, 5]);
        expect(later.runs).toBe(1);
      }),
      options,
    );

    test(
      "a hundred entities answer at once",
      Effect.gen(function* () {
        const values = yield* Effect.all(
          Array.from({ length: 100 }, (_, i) =>
            get(`${baseUrl}/whoami/cf-fan-${i}`).pipe(Effect.map((body) => body.value as string)),
          ),
          { concurrency: 50 },
        );
        expect(values).toEqual(Array.from({ length: 100 }, (_, i) => `cf-fan-${i}`));
      }),
      options,
    );

    // Last: it gives the pool's Worker a new version.
    test(
      "a deploy keeps held instances, delivers what was scheduled, and keeps singletons running",
      Effect.gen(function* () {
        expect((yield* get(`${baseUrl}/generation/cf-deploy`)).value).toBe("1");
        // An instance held alive, and a message due after the deploy.
        yield* get(`${baseUrl}/pin/cf-deploy`);
        const before: number = (yield* get(`${baseUrl}/built-at/cf-deploy`)).builtAt;
        const at: number = (yield* get(`${baseUrl}/later/cf-deploy/90000`)).at;

        yield* deploy("2");
        // The hosted class reads its new Config once the new version serves.
        yield* get(`${baseUrl}/generation/cf-deploy`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (body) => body.value === "2",
            times: 30,
          }),
        );

        // Cloudflare moves an object to the new version once it has been
        // idle, so one held awake keeps its instance for minutes (measured:
        // over four). Whichever version answers, the entity is still held.
        yield* Effect.sleep("15 seconds");
        const after = yield* get(`${baseUrl}/built-at/cf-deploy`);
        expect(after.builtAt).toBeGreaterThanOrEqual(before);
        expect(after.age).toBeGreaterThan(5_000);

        // The message stored before the deploy runs at its time.
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        yield* Effect.sleep(Duration.millis(Math.max(0, at - now) + 5_000));
        const ranAt: number = (yield* get(`${baseUrl}/ran-at/cf-deploy`)).value;
        expect(ranAt).toBeGreaterThanOrEqual(at - 1_000);
        expect(ranAt - at).toBeLessThanOrEqual(5_000);
        expect((yield* get(`${baseUrl}/get/cf-deploy`)).value).toBe(5);

        // The singleton beats again on the new version.
        const beats: string[] = yield* get(`${baseUrl}/wf/journal/heartbeat`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (entries: string[]) => entries.length >= 3,
            times: 60,
          }),
        );
        expect(beats.length).toBeGreaterThanOrEqual(3);
      }),
      { timeout: 300_000, tags: ["live"] },
    );
  },
);
