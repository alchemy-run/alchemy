import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ExecuteQuery, type ExecuteQueryRequest } from "./ExecuteQuery.ts";
import type { Graph } from "./Graph.ts";

/**
 * HTTP implementation of the {@link ExecuteQuery} binding — signs
 * `neptune-graph:ExecuteQuery` data-plane requests against the graph's HTTPS
 * endpoint and, at deploy time, grants the query IAM actions on the bound
 * {@link Graph} to the host function.
 *
 * Provide it on the Lambda function that uses the binding:
 *
 * @example
 * ```typescript
 * export default QueryFunction.make(
 *   { main, url: true },
 *   Effect.gen(function* () {
 *     // init — bind the graph
 *     const executeQuery = yield* NeptuneGraph.ExecuteQuery(graph);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — run an openCypher query
 *         const response = yield* executeQuery({
 *           queryString: "MATCH (n) RETURN count(n) AS nodes",
 *           language: "OPEN_CYPHER",
 *         });
 *         const body = yield* response.payload.pipe(
 *           Stream.decodeText,
 *           Stream.mkString,
 *         );
 *         return yield* HttpServerResponse.json(JSON.parse(body));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(NeptuneGraph.ExecuteQueryHttp)),
 * );
 * ```
 */
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
