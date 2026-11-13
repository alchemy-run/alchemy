import { fileURLToPath } from "node:url";
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as udf from "@distilled.cloud/clickhouse-cloud/udf";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const source = fileURLToPath(new URL("../fixtures/udf/double", import.meta.url));

const getFunction = (functionName: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* udf
      .getUdf({ organizationId, functionName })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  });

const declare = (memoryLimitMib: number) =>
  ClickHouseCloud.Udf.Function("Double", {
    source,
    runtime: "python3.11",
    arguments: [{ name: "x", type: "UInt64" }],
    returnType: "UInt64",
    memoryLimitMib,
  });

test.provider(
  "build a Python UDF, publish a new version on a configuration change, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const first = yield* stack.deploy(declare(128));
      expect(first.status).toEqual("ready");
      expect(first.functionName).not.toContain("-");
      const observed = yield* getFunction(first.functionName);
      expect(observed?.memoryLimitMib).toEqual(128);
      expect(observed?.version).toEqual(first.version);

      // Unchanged code and configuration: no new version.
      const unchanged = yield* stack.deploy(declare(128));
      expect(unchanged.version).toEqual(first.version);

      // A new memory limit is a new version of the same function.
      const second = yield* stack.deploy(declare(256));
      expect(second.functionName).toEqual(first.functionName);
      expect(second.version).toEqual(first.version + 1);
      expect((yield* getFunction(first.functionName))?.memoryLimitMib).toEqual(256);

      yield* stack.destroy();
      expect(yield* getFunction(first.functionName)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 1_800_000 },
);
