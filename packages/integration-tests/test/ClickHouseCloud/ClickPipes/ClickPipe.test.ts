import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { STATIONS_CSV } from "../fixtures/resources.ts";
import { needsService, testServiceId } from "../fixtures/service.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const getPipe = (serviceId: string, clickPipeId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* pipes
      .getClickPipe({ organizationId, serviceId, clickPipeId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  });

const declare = (props: { name?: string; delimiter?: string }) =>
  Effect.gen(function* () {
    const serviceId = yield* testServiceId;
    return yield* ClickHouseCloud.ClickPipes.ClickPipe("Stations", {
      serviceId,
      name: props.name,
      source: {
        objectStorage: {
          type: "s3",
          format: "CSVWithNames",
          url: STATIONS_CSV,
          ...(props.delimiter !== undefined ? { delimiter: props.delimiter } : {}),
          isContinuous: false,
        },
      },
      destination: {
        database: "default",
        table: "alchemy_test_stations",
        managedTable: true,
        tableDefinition: { engine: { type: "MergeTree" }, sortingKey: ["station"] },
        columns: [
          { name: "station", type: "String" },
          { name: "avg", type: "Float64" },
        ],
      },
      fieldMappings: [
        { sourceField: "station", destinationField: "station" },
        { sourceField: "avg", destinationField: "avg" },
      ],
    });
  });

test.provider.skipIf(needsService)(
  "load a public CSV with a one-shot pipe, rename it in place, replace it on a new delimiter, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);

      const created = yield* stack.deploy(declare({}));
      expect(created.state).toEqual("Completed");
      expect((yield* getPipe(created.serviceId, created.clickPipeId))?.state).toEqual("Completed");

      const renamed = yield* stack.deploy(declare({ name: "alchemy stations" }));
      expect(renamed.clickPipeId).toEqual(created.clickPipeId);
      expect((yield* getPipe(created.serviceId, created.clickPipeId))?.name).toEqual(
        "alchemy stations",
      );

      // The delimiter can't change on a pipe: a new one replaces it.
      const replaced = yield* stack.deploy(declare({ name: "alchemy stations", delimiter: "," }));
      expect(replaced.clickPipeId).not.toEqual(created.clickPipeId);
      expect(yield* getPipe(created.serviceId, created.clickPipeId)).toBeUndefined();

      yield* stack.destroy();
      expect(yield* getPipe(created.serviceId, replaced.clickPipeId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 1_800_000 },
);
