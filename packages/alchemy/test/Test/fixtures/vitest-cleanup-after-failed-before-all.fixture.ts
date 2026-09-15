import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeAll } from "vitest";
import * as Test from "alchemy/Test/Vitest";

const testApi = Test.make({ providers: Layer.empty, dev: false });

testApi.beforeAll(
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      console.log("VITEST_CLEANUP_AFTER_FAILED_BEFORE_ALL");
    }),
  ),
);

beforeAll(() => {
  throw new Error("EXPECTED_BEFORE_ALL_FAILURE");
});

testApi.test("is skipped after beforeAll fails", Effect.void);
