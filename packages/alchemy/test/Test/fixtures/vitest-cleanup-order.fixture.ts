import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, expect } from "vitest";
import * as Test from "alchemy/Test/Vitest";

const lifecycleEvents: string[] = [];
const testApi = Test.make({ providers: Layer.empty, dev: false });

const reportLifecycleEvents = () =>
  console.log(`VITEST_CLEANUP_ORDER:${lifecycleEvents.join(",")}`);

testApi.beforeAll(
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      lifecycleEvents.push("alchemy fallback cleanup");
      reportLifecycleEvents();
    }),
  ),
);

testApi.test("runs a test before cleanup", Effect.void);

afterAll(() => {
  expect(lifecycleEvents).toEqual([]);
  lifecycleEvents.push("user afterAll");
});
