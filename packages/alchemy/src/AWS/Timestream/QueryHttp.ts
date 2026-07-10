import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Query, type QueryRequest } from "./Query.ts";
import type { Table } from "./Table.ts";
import { discover, withEndpoint } from "./internal.ts";

export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const query = yield* TSQ.query;
    const describeEndpoints = yield* TSQ.describeEndpoints;
    const withQueryEndpoint = withEndpoint(
      discover("query", describeEndpoints({})),
    );
    return Effect.fn(function* (table: Table) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Timestream.Query(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["timestream:Select"],
                Resource: [Output.interpolate`${table.tableArn}`],
              },
              // Endpoint discovery is required and is not scoped to a resource.
              {
                Effect: "Allow",
                Action: ["timestream:DescribeEndpoints"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Timestream.Query(${table.LogicalId})`)(function* (
        request: QueryRequest,
      ) {
        return yield* withQueryEndpoint(query(request));
      });
    });
  }),
);
