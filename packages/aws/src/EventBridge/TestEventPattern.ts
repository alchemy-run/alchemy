import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";

export interface TestEventPatternRequest extends eventbridge.TestEventPatternRequest {}

/**
 * Tests whether an event matches an event pattern
 * (`events:TestEventPattern`).
 *
 * An account-level operation — bind it with no resource argument. Useful for
 * validating patterns before creating a `Rule`. Provide the
 * `TestEventPatternHttp` layer on the Function to satisfy the binding.
 * ### Testing Patterns
 * **Example:** Test an Event Against a Pattern
 * ```typescript
 * // init — no resource argument (provide AWS.EventBridge.TestEventPatternHttp on the Function)
 * const testEventPattern = yield* AWS.EventBridge.TestEventPattern();
 *
 * // runtime — check whether the event would match
 * const { Result } = yield* testEventPattern({
 *   EventPattern: JSON.stringify({ source: ["my.app"] }),
 *   Event: JSON.stringify({
 *     id: "1",
 *     source: "my.app",
 *     "detail-type": "OrderCreated",
 *     account: "123456789012",
 *     region: "us-east-1",
 *     time: new Date().toISOString(),
 *     detail: {},
 *   }),
 * });
 * ```
 *
 * @binding
 */
export interface TestEventPattern extends Binding.Service<
  TestEventPattern,
  "AWS.EventBridge.TestEventPattern",
  () => Effect.Effect<
    (
      request: TestEventPatternRequest,
    ) => Effect.Effect<eventbridge.TestEventPatternResponse, eventbridge.TestEventPatternError>
  >
> {}
export const TestEventPattern = Binding.Service<TestEventPattern>(
  "AWS.EventBridge.TestEventPattern",
);

/**
 * HTTP implementation of {@link TestEventPattern}. At deploy time it grants
 * `events:TestEventPattern`; at runtime it calls the EventBridge API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const TestEventPatternHttp = Layer.effect(
  TestEventPattern,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.TestEventPattern",
    operation: eventbridge.testEventPattern,
    actions: ["events:TestEventPattern"],
  }),
);
