import * as AWS from "@/AWS";
import { EventBus } from "@/AWS/EventBridge/EventBus.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// event bus, resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed bus appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed event bus", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bus = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* EventBus("ListEventBus", {
          name: "alchemy-test-eventbus-list",
        });
      }),
    );

    const provider = yield* Provider.findProvider(EventBus);
    const all = yield* provider.list();

    expect(all.some((b) => b.eventBusName === bus.eventBusName)).toBe(true);
    // The AWS-managed `default` bus must be excluded.
    expect(all.some((b) => b.eventBusName === "default")).toBe(false);

    yield* stack.destroy();
  }),
);
