import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { LogGroup } from "./LogGroup.ts";
import { StartQuery, type StartQueryRequest } from "./StartQuery.ts";

export const StartQueryHttp = Layer.effect(
  StartQuery,
  Effect.gen(function* () {
    const startQuery = yield* Logs.startQuery;

    return Effect.fn(function* <G extends LogGroup>(logGroup: G) {
      const LogGroupName = yield* logGroup.logGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Logs.StartQuery(${logGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["logs:StartQuery", "logs:StopQuery"],
                Resource: [
                  logGroup.logGroupArn,
                  Output.interpolate`${logGroup.logGroupArn}:*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Logs.StartQuery(${logGroup.LogicalId})`)(function* (
        request: StartQueryRequest,
      ) {
        const logGroupName = yield* LogGroupName;
        return yield* startQuery({
          ...request,
          logGroupName,
        });
      });
    });
  }),
);
