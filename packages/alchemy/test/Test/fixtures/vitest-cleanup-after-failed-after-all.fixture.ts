import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll } from "vitest";
import * as Test from "alchemy/Test/Vitest";

const testApi = Test.make({ providers: Layer.empty, dev: false });

testApi.beforeAll(
  Effect.addFinalizer(() =>
    Effect.sync(() => {
      console.log("VITEST_CLEANUP_AFTER_FAILED_AFTER_ALL");
    }),
  ),
);

testApi.test("runs before afterAll fails", Effect.void);

afterAll(() => {
  throw new Error("EXPECTED_AFTER_ALL_FAILURE");
});
