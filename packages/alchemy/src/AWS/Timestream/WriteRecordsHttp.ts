import * as TSW from "@distilled.cloud/aws/timestream-write";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import { discover, withEndpoint } from "./internal.ts";
import { WriteRecords, type WriteRecordsRequest } from "./WriteRecords.ts";

export const WriteRecordsHttp = Layer.effect(
  WriteRecords,
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const writeRecords = yield* TSW.writeRecords;
    const describeEndpoints = yield* TSW.describeEndpoints;
    const withWriteEndpoint = withEndpoint(
      discover("write", describeEndpoints({})),
    );
    return Effect.fn(function* (table: Table) {
      const DatabaseName = yield* table.databaseName;
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Timestream.WriteRecords(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["timestream:WriteRecords"],
                  Resource: [Output.interpolate`${table.tableArn}`],
                },
                // Timestream requires endpoint discovery; the ingest endpoint
                // is resolved at runtime via DescribeEndpoints, which is not
                // scoped to a resource.
                {
                  Effect: "Allow",
                  Action: ["timestream:DescribeEndpoints"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Timestream.WriteRecords(${table.LogicalId})`)(
        function* (request: WriteRecordsRequest) {
          return yield* withWriteEndpoint(
            writeRecords({
              ...request,
              DatabaseName: yield* DatabaseName,
              TableName: yield* TableName,
            }),
          );
        },
      );
    });
  }),
);
