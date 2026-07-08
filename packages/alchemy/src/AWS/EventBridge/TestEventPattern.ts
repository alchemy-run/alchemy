import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface TestEventPatternRequest
  extends eventbridge.TestEventPatternRequest {}

/** @binding */
export interface TestEventPattern extends Binding.Service<
  TestEventPattern,
  "AWS.EventBridge.TestEventPattern",
  () => Effect.Effect<
    (
      request: TestEventPatternRequest,
    ) => Effect.Effect<
      eventbridge.TestEventPatternResponse,
      eventbridge.TestEventPatternError
    >
  >
> {}
export const TestEventPattern = Binding.Service<TestEventPattern>(
  "AWS.EventBridge.TestEventPattern",
);
