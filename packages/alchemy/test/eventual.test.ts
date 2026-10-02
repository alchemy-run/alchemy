import { dependsOn } from "@/DependsOn";
import { isResolved } from "@/Diff";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import { Stack } from "@/Stack";
import { type ResourceState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { TestLayers } from "./test.resources.ts";

// A resource with one eventual attribute (`url`): `reconcile` never knows it,
// `settle` produces it after a delay — like a Service's load balancer address.
interface Service extends Resource<
  "Test.EventualService",
  { name: string; failSettle?: boolean },
  { name: string; url: string | undefined }
> {}
const Service = Resource<Service>("Test.EventualService");

// A plain consumer that records the value it was reconciled with.
interface Consumer extends Resource<
  "Test.EventualConsumer",
  { value?: string; delay?: number },
  { value: string | undefined }
> {}
const Consumer = Resource<Consumer>("Test.EventualConsumer");

/** Ordered record of reconciles and settles, reset per test. */
const log: string[] = [];
let settleCalls = 0;

const serviceProvider = () =>
  Provider.succeed(Service, {
    eventual: ["url"],
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news }) {
      log.push(`reconcile:${id}`);
      return { name: news.name, url: undefined };
    }),
    settle: Effect.fn(function* ({ id, news, output }) {
      settleCalls++;
      if (output.url !== undefined) return {};
      yield* Effect.sleep("150 millis");
      if (news.failSettle) {
        return yield* Effect.fail(new Error(`${id}: load balancer failed`));
      }
      log.push(`settle:${id}`);
      return { url: `https://${news.name}.example.com` };
    }),
    delete: Effect.fn(function* () {}),
  });

const consumerProvider = () =>
  Provider.succeed(Consumer, {
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news }) {
      if (news.delay) yield* Effect.sleep(`${news.delay} millis`);
      log.push(`reconcile:${id}`);
      return { value: news.value };
    }),
    delete: Effect.fn(function* () {}),
  });

const { test } = Test.make({
  providers: Layer.mergeAll(
    TestLayers(),
    serviceProvider(),
    consumerProvider(),
  ),
});

const reset = Effect.sync(() => {
  log.length = 0;
  settleCalls = 0;
});

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stack = yield* Stack;
  return (yield* state.get({
    stack: stack.name,
    stage: stack.stage,
    fqn,
  })) as ResourceState | undefined;
});

describe("eventual attributes", { tags: ["unit", "local"] }, () => {
  test.provider(
    "an unreferenced eventual attribute is never settled",
    (stack) =>
      Effect.gen(function* () {
        yield* reset;
        yield* Effect.gen(function* () {
          const svc = yield* Service("Svc", { name: "api" });
          yield* Consumer("NameReader", { value: svc.name });
        }).pipe(stack.deploy);

        expect(settleCalls).toBe(0);
        const row = yield* getState("Svc");
        expect(row?.attr?.url).toBeUndefined();
        expect(row?.settled).toBeUndefined();
        yield* stack.destroy();
      }),
  );

  test.provider("a consumer that reads it gets the settled value", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      yield* Effect.gen(function* () {
        const svc = yield* Service("Svc", { name: "api" });
        yield* Consumer("UrlReader", { value: svc.url });
      }).pipe(stack.deploy);

      expect(settleCalls).toBe(1);
      expect((yield* getState("UrlReader"))?.attr?.value).toBe(
        "https://api.example.com",
      );
      const row = yield* getState("Svc");
      expect(row?.attr?.url).toBe("https://api.example.com");
      expect(row?.settled).toEqual(["url"]);
      yield* stack.destroy();
    }),
  );

  test.provider(
    "consumers that don't read it aren't delayed by settle",
    (stack) =>
      Effect.gen(function* () {
        yield* reset;
        yield* Effect.gen(function* () {
          const svc = yield* Service("Svc", { name: "api" });
          yield* Consumer("NameReader", { value: svc.name });
          yield* Consumer("UrlReader", { value: svc.url });
        }).pipe(stack.deploy);

        expect(log.indexOf("reconcile:NameReader")).toBeLessThan(
          log.indexOf("settle:Svc"),
        );
        expect(log.indexOf("settle:Svc")).toBeLessThan(
          log.indexOf("reconcile:UrlReader"),
        );
        yield* stack.destroy();
      }),
  );

  test.provider("a stack output that reads it is settled", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      const output = yield* Effect.gen(function* () {
        const svc = yield* Service("Svc", { name: "api" });
        return { url: svc.url };
      }).pipe(stack.deploy);

      expect(output.url).toBe("https://api.example.com");
      expect(settleCalls).toBe(1);
      yield* stack.destroy();
    }),
  );

  test.provider(
    "an unchanged resource settles when a new consumer reads it, then only once",
    (stack) =>
      Effect.gen(function* () {
        yield* reset;
        yield* Effect.gen(function* () {
          yield* Service("Svc", { name: "api" });
        }).pipe(stack.deploy);
        expect(settleCalls).toBe(0);

        const withReader = Effect.gen(function* () {
          const svc = yield* Service("Svc", { name: "api" });
          yield* Consumer("UrlReader", { value: svc.url });
        });

        yield* withReader.pipe(stack.deploy);
        expect(settleCalls).toBe(1);
        expect((yield* getState("UrlReader"))?.attr?.value).toBe(
          "https://api.example.com",
        );

        // Already settled: the next deploy reads it from state.
        yield* withReader.pipe(stack.deploy);
        expect(settleCalls).toBe(1);
        expect((yield* getState("UrlReader"))?.attr?.value).toBe(
          "https://api.example.com",
        );
        yield* stack.destroy();
      }),
  );

  test.provider("a failed settle fails the deploy and its readers", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      const exit = yield* Effect.gen(function* () {
        const svc = yield* Service("Svc", { name: "api", failSettle: true });
        yield* Consumer("NameReader", { value: svc.name });
        yield* Consumer("UrlReader", { value: svc.url });
      }).pipe(stack.deploy, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        Exit.isFailure(exit) && String(Cause.squash(exit.cause)),
      ).toContain("load balancer failed");
      expect(log).toContain("reconcile:NameReader");
      expect(log).not.toContain("reconcile:UrlReader");
      yield* stack.destroy();
    }),
  );

  test.provider("--settle-timeout bounds a slow settle", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      const exit = yield* Effect.gen(function* () {
        const svc = yield* Service("Svc", { name: "api" });
        yield* Consumer("UrlReader", { value: svc.url });
      }).pipe(
        (effect) => stack.deploy(effect, { settleTimeout: "20 millis" }),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("SettleTimeout");
      expect(log).not.toContain("reconcile:UrlReader");
      yield* stack.destroy();
    }),
  );
});

describe("dependsOn", { tags: ["unit", "local"] }, () => {
  test.provider("orders a resource after one it doesn't read from", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      yield* Effect.gen(function* () {
        const first = yield* Consumer("First", { delay: 100 });
        yield* Consumer("Second", {}).pipe(dependsOn(first));
      }).pipe(stack.deploy);

      expect(log).toEqual(["reconcile:First", "reconcile:Second"]);
      expect((yield* getState("First"))?.downstream).toEqual(["Second"]);
      yield* stack.destroy();
    }),
  );

  test.provider(
    "waits for every eventual attribute of a whole resource",
    (stack) =>
      Effect.gen(function* () {
        yield* reset;
        yield* Effect.gen(function* () {
          const svc = yield* Service("Svc", { name: "api" });
          yield* Consumer("After", {}).pipe(dependsOn(svc));
        }).pipe(stack.deploy);

        expect(log).toEqual(["reconcile:Svc", "settle:Svc", "reconcile:After"]);
        yield* stack.destroy();
      }),
  );

  test.provider("waits for a single attribute", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      yield* Effect.gen(function* () {
        const svc = yield* Service("Svc", { name: "api" });
        yield* Consumer("AfterName", {}).pipe(dependsOn(svc.name));
        yield* Consumer("AfterUrl", {}).pipe(dependsOn(svc.url));
      }).pipe(stack.deploy);

      expect(log.indexOf("reconcile:AfterName")).toBeLessThan(
        log.indexOf("settle:Svc"),
      );
      expect(log.indexOf("settle:Svc")).toBeLessThan(
        log.indexOf("reconcile:AfterUrl"),
      );
      yield* stack.destroy();
    }),
  );

  test.provider("nested dependsOn calls accumulate", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      yield* Effect.gen(function* () {
        const a = yield* Consumer("A", { delay: 80 });
        const b = yield* Consumer("B", { delay: 40 });
        yield* Consumer("C", {}).pipe(dependsOn(a), dependsOn(b));
      }).pipe(stack.deploy);

      expect(log.at(-1)).toBe("reconcile:C");
      yield* stack.destroy();
    }),
  );

  test.provider("adding or removing it doesn't change the diff", (stack) =>
    Effect.gen(function* () {
      yield* reset;
      yield* Effect.gen(function* () {
        yield* Consumer("First", {});
        yield* Consumer("Second", {});
      }).pipe(stack.deploy);

      const plan = yield* Effect.gen(function* () {
        const first = yield* Consumer("First", {});
        yield* Consumer("Second", {}).pipe(dependsOn(first));
      }).pipe(stack.plan);

      expect(plan.resources.Second?.action).toBe("noop");
      expect(plan.resources.First?.action).toBe("noop");
      yield* stack.destroy();
    }),
  );
});
