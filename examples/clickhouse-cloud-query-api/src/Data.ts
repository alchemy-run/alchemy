// src/Data.ts
import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

/** The smallest service: one 8 GB replica that idles after five minutes. */
export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
  provider: "aws",
  region: "us-east-1",
  minReplicaMemoryGb: 8,
  maxReplicaMemoryGb: 8,
  numReplicas: 1,
  idleScaling: true,
  idleTimeoutMinutes: 5,
  ipAccessList: [{ source: "0.0.0.0/0", description: "anywhere" }],
});

/** Loads the weather stations CSV (412 rows) into `default.stations` once. */
export const Stations = Effect.gen(function* () {
  const analytics = yield* Analytics;
  return yield* ClickHouseCloud.ClickPipes.ClickPipe("Stations", {
    serviceId: analytics.serviceId,
    source: {
      objectStorage: {
        type: "s3",
        format: "CSVWithNames",
        url: "https://datasets-documentation.s3.eu-west-3.amazonaws.com/1brc/stations.csv",
        isContinuous: false,
      },
    },
    destination: {
      database: "default",
      table: "stations",
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

/** The `n` hottest stations, as an HTTPS endpoint. */
export const Hottest = Effect.gen(function* () {
  const analytics = yield* Analytics;
  const stations = yield* Stations;
  return yield* ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint("Hottest", {
    serviceId: analytics.serviceId,
    // Read from the pipe's table, so the endpoint is created after the load.
    database: Output.map(stations.destination, (d) => d?.database ?? "default"),
    sql: "SELECT station, avg FROM stations ORDER BY avg DESC, station LIMIT {n:UInt8}",
    parameters: { n: "5" },
    roles: ["default_role"],
  });
});
