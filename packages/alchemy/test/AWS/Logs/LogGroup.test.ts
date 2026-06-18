import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs/LogGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const describeLogGroup = Effect.fn(function* (logGroupName: string) {
  const described = yield* logs.describeLogGroups({
    logGroupNamePrefix: logGroupName,
    limit: 1,
  });
  return (described.logGroups ?? []).find(
    (group) => group.logGroupName === logGroupName,
  );
});

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

test.provider("configures log group class and deletion protection", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* LogGroup("ConfiguredLogGroup", {
          retentionInDays: 7,
          logGroupClass: "INFREQUENT_ACCESS",
          deletionProtectionEnabled: false,
        });
      }),
    );

    expect(created.logGroupClass).toBe("INFREQUENT_ACCESS");
    expect(created.deletionProtectionEnabled).toBe(false);

    const observedCreated = yield* describeLogGroup(created.logGroupName);
    expect(observedCreated?.logGroupClass).toBe("INFREQUENT_ACCESS");
    expect(observedCreated?.deletionProtectionEnabled).toBe(false);
    expect(observedCreated?.retentionInDays).toBe(7);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* LogGroup("ConfiguredLogGroup", {
          retentionInDays: 14,
          logGroupClass: "INFREQUENT_ACCESS",
          deletionProtectionEnabled: true,
        });
      }),
    );

    expect(updated.logGroupClass).toBe("INFREQUENT_ACCESS");
    expect(updated.deletionProtectionEnabled).toBe(true);

    const observedUpdated = yield* describeLogGroup(updated.logGroupName);
    expect(observedUpdated?.logGroupClass).toBe("INFREQUENT_ACCESS");
    expect(observedUpdated?.deletionProtectionEnabled).toBe(true);
    expect(observedUpdated?.retentionInDays).toBe(14);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* LogGroup("ConfiguredLogGroup", {
          retentionInDays: 14,
          logGroupClass: "STANDARD",
          deletionProtectionEnabled: false,
        });
      }),
    );

    expect(replaced.logGroupName).not.toBe(updated.logGroupName);
    expect(replaced.logGroupClass).toBe("STANDARD");
    expect(replaced.deletionProtectionEnabled).toBe(false);

    const observedReplaced = yield* describeLogGroup(replaced.logGroupName);
    expect(observedReplaced?.logGroupClass ?? "STANDARD").toBe("STANDARD");
    expect(observedReplaced?.deletionProtectionEnabled).toBe(false);
    expect(observedReplaced?.retentionInDays).toBe(14);
    expect(yield* describeLogGroup(updated.logGroupName)).toBeUndefined();

    yield* stack.destroy();
    expect(yield* describeLogGroup(replaced.logGroupName)).toBeUndefined();
  }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
);
