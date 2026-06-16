import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs/LogGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// log group, resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed log group appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed log group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const logGroup = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* LogGroup("ListLogGroup", {
          logGroupName: "alchemy-test-log-group-list",
          retentionInDays: 7,
        });
      }),
    );

    const provider = yield* Provider.findProvider(LogGroup);
    const all = yield* provider.list();

    expect(all.some((g) => g.logGroupName === logGroup.logGroupName)).toBe(
      true,
    );

    yield* stack.destroy();
  }),
);
