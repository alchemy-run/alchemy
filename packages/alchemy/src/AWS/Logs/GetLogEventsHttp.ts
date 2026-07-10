import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import { GetLogEvents, type GetLogEventsRequest } from "./GetLogEvents.ts";
import type { LogGroup } from "./LogGroup.ts";

export const GetLogEventsHttp = Layer.effect(
  GetLogEvents,
  Effect.gen(function* () {
    const getLogEvents = yield* Logs.getLogEvents;

    return Effect.fn(function* <G extends LogGroup>(logGroup: G) {
      const LogGroupName = yield* logGroup.logGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Logs.GetLogEvents(${logGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["logs:GetLogEvents"],
                Resource: [
                  logGroup.logGroupArn,
                  Output.interpolate`${logGroup.logGroupArn}:*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Logs.GetLogEvents(${logGroup.LogicalId})`)(
        function* (request: GetLogEventsRequest) {
          const logGroupName = yield* LogGroupName;
          return yield* getLogEvents({
            ...request,
            logGroupName,
          });
        },
      );
    });
  }),
);
