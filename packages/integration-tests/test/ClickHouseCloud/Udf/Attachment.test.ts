import { fileURLToPath } from "node:url";
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as udf from "@distilled.cloud/clickhouse-cloud/udf";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const source = fileURLToPath(new URL("../fixtures/udf/double", import.meta.url));

const getAttachment = (functionName: string, serviceId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* udf.getUdfAttachment({ organizationId, functionName, serviceId }).pipe(
      Effect.map(({ result }) => result),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );
  });

const declare = (memoryLimitMib: number) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    const fn = yield* ClickHouseCloud.Udf.Function("AttachedDouble", {
      source,
      runtime: "python3.11",
      arguments: [{ name: "x", type: "UInt64" }],
      returnType: "UInt64",
      memoryLimitMib,
    });
    const attachment = yield* ClickHouseCloud.Udf.Attachment("DoubleOnService", {
      functionName: fn.functionName,
      serviceId,
      version: fn.version,
    });
    return { fn, attachment };
  });

test.provider.skipIf(needsService)(
  "attach a UDF to a service, follow its new version, detach it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const first = yield* stack.deploy(declare(128));
      expect(first.attachment.status).toEqual("deployed");
      expect(first.attachment.version).toEqual(first.fn.version);

      const second = yield* stack.deploy(declare(256));
      expect(second.attachment.version).toEqual(second.fn.version);
      expect(
        (yield* getAttachment(first.fn.functionName, first.attachment.serviceId))?.version,
      ).toEqual(second.fn.version);

      yield* stack.destroy();
      expect(
        yield* getAttachment(first.fn.functionName, first.attachment.serviceId),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 1_800_000 },
);
