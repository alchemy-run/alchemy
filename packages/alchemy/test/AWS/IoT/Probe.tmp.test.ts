import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as Effect from "effect/Effect";
import { describe } from "vitest";

import IoTBindingsFunctionLive, {
  IoTBindingsFunction,
} from "./iot-bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

describe("IoT deploy probe (tmp)", () => {
  test.provider(
    "deploy fixture and inspect env",
    (stack) =>
      Effect.gen(function* () {
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* IoTBindingsFunction;
          }).pipe(Effect.provide(IoTBindingsFunctionLive)),
        );
        yield* stack.destroy();
        throw new Error(`PROBE deployed ${JSON.stringify(Object.keys(out))}`);
      }),
    { timeout: 300_000 },
  );
});
