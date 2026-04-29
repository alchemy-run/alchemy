import { defineSchema } from "@/Sidecar/RpcHandler.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class TestServiceError extends Schema.TaggedErrorClass<TestServiceError>()(
  "TestServiceError",
  {
    message: Schema.String,
  },
) {}

export const TestServiceSchema = defineSchema<TestService>({
  get: { success: Schema.String, error: Schema.Never },
  fail: { success: Schema.Never, error: TestServiceError },
});

export const TestService = Effect.gen(function* () {
  return {
    get: () => Effect.succeed("Hello, world!"),
    fail: () => Effect.fail(new TestServiceError({ message: "Failed" })),
  };
});
export type TestService = Effect.Success<typeof TestService>;
