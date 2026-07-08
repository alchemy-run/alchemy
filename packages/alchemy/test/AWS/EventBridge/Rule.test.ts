import * as AWS from "@/AWS";
import { Rule } from "@/AWS/EventBridge/Rule.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection across all
// event buses): deploy a real rule, resolve the provider from context via the
// typed `findProvider`, call `list()`, and assert the deployed rule appears in
// the exhaustively-paginated result.
test.provider("list enumerates the deployed rule", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const rule = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Rule("ListRule", {
          name: "alchemy-test-rule-list",
          scheduleExpression: "rate(5 minutes)",
        });
      }),
    );

    const provider = yield* Provider.findProvider(Rule);
    const all = yield* provider.list();

    expect(all.some((r) => r.ruleName === rule.ruleName)).toBe(true);
    expect(
      all.some(
        (r) =>
          r.ruleName === rule.ruleName && r.eventBusName === rule.eventBusName,
      ),
    ).toBe(true);

    yield* stack.destroy();
  }),
);
