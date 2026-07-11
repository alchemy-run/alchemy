import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ExecuteQuery, type ExecuteQueryRequest } from "./ExecuteQuery.ts";
import type { Graph } from "./Graph.ts";

export const ExecuteQueryHttp = Layer.effect(
  ExecuteQuery,
  Effect.gen(function* () {
    const executeQuery = yield* neptunegraph.executeQuery;

    return Effect.fn(function* <G extends Graph>(graph: G) {
      const GraphId = yield* graph.graphId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.NeptuneGraph.ExecuteQuery(${graph}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "neptune-graph:ReadDataViaQuery",
                    "neptune-graph:WriteDataViaQuery",
                    "neptune-graph:DeleteDataViaQuery",
                  ],
                  Resource: [graph.graphArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.NeptuneGraph.ExecuteQuery(${graph.LogicalId})`)(
        function* (request: ExecuteQueryRequest) {
          const graphIdentifier = yield* GraphId;
          return yield* executeQuery({
            ...request,
            graphIdentifier,
          });
        },
      );
    });
  }),
);
