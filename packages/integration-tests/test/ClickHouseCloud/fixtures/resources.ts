import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import * as Effect from "effect/Effect";

/** The smallest service: one 8 GB replica that idles after 5 minutes. */
export const small = {
  provider: "aws" as const,
  region: "us-east-1" as const,
  minReplicaMemoryGb: 8,
  maxReplicaMemoryGb: 8,
  numReplicas: 1,
  idleScaling: true,
  idleTimeoutMinutes: 5,
};

/** The organization the credentials belong to, bound by the organization bindings. */
export const Org = ClickHouseCloud.Organization.Organization("BindingsOrg", {});

/** The smallest service, bound by the service bindings. */
export const Analytics = ClickHouseCloud.Service.Service("BindingsAnalytics", {
  ...small,
  ipAccessList: [{ source: "0.0.0.0/0", description: "bindings test" }],
});

/** 412 rows, 7 KB: ClickHouse's own public dataset bucket. */
export const STATIONS_CSV =
  "https://datasets-documentation.s3.eu-west-3.amazonaws.com/1brc/stations.csv";

/** The public CSV as a ClickPipes object storage source. */
export const stationsSource = {
  type: "s3",
  format: "CSVWithNames",
  url: STATIONS_CSV,
  isContinuous: false,
} as const;

/** A one-shot pipe into the bound service, bound by GetClickPipe and UpdateClickPipeState. */
export const StationsPipe = Effect.gen(function* () {
  const analytics = yield* Analytics;
  return yield* ClickHouseCloud.ClickPipes.ClickPipe("BindingsStations", {
    serviceId: analytics.serviceId,
    source: { objectStorage: stationsSource },
    destination: {
      database: "default",
      table: "bindings_stations",
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

/** A Query API endpoint on the bound service, run by RunQueryApiEndpoint. */
export const NumbersEndpoint = Effect.gen(function* () {
  const analytics = yield* Analytics;
  return yield* ClickHouseCloud.QueryApiEndpoints.QueryApiEndpoint("BindingsNumbers", {
    serviceId: analytics.serviceId,
    database: "default",
    sql: "SELECT number FROM system.numbers LIMIT {n:UInt8}",
    parameters: { n: "2" },
    roles: ["default_role"],
  });
});

/** The smallest Postgres service, bound by the Postgres bindings. */
export const BindingsDb = ClickHouseCloud.Postgres.Service("BindingsDb", {
  provider: "aws",
  region: "us-east-1",
  postgresVersion: "17",
  size: "r6gd.medium",
  // The test runner connects with what Connect hands the Worker.
  ipAccessList: [{ source: "0.0.0.0/0", portRange: "5432", description: "bindings test" }],
});
