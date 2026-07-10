import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetQueryResults,
  type GetQueryResultsRequest,
} from "./GetQueryResults.ts";
import type { LogGroup } from "./LogGroup.ts";

export const GetQueryResultsHttp = Layer.effect(
  GetQueryResults,
  Effect.gen(function* () {
    const getQueryResults = yield* Logs.getQueryResults;

    return Effect.fn(function* <G extends LogGroup>(logGroup: G) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Logs.GetQueryResults(${logGroup}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["logs:GetQueryResults"],
                  Resource: [
                    logGroup.logGroupArn,
                    Output.interpolate`${logGroup.logGroupArn}:*`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Logs.GetQueryResults(${logGroup.LogicalId})`)(
        function* (request: GetQueryResultsRequest) {
          return yield* getQueryResults(request);
        },
      );
    });
  }),
);
