import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  FilterLogEvents,
  type FilterLogEventsRequest,
} from "./FilterLogEvents.ts";
import type { LogGroup } from "./LogGroup.ts";

export const FilterLogEventsHttp = Layer.effect(
  FilterLogEvents,
  Effect.gen(function* () {
    const filterLogEvents = yield* Logs.filterLogEvents;

    return Effect.fn(function* <G extends LogGroup>(logGroup: G) {
      const LogGroupName = yield* logGroup.logGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Logs.FilterLogEvents(${logGroup}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["logs:FilterLogEvents"],
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
      return Effect.fn(`AWS.Logs.FilterLogEvents(${logGroup.LogicalId})`)(
        function* (request?: FilterLogEventsRequest) {
          const logGroupName = yield* LogGroupName;
          return yield* filterLogEvents({
            ...request,
            logGroupName,
          });
        },
      );
    });
  }),
);
