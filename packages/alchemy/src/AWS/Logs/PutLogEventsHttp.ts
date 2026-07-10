import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { LogGroup } from "./LogGroup.ts";
import { PutLogEvents, type PutLogEventsRequest } from "./PutLogEvents.ts";

export const PutLogEventsHttp = Layer.effect(
  PutLogEvents,
  Effect.gen(function* () {
    const putLogEvents = yield* Logs.putLogEvents;

    return Effect.fn(function* <G extends LogGroup>(logGroup: G) {
      const LogGroupName = yield* logGroup.logGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Logs.PutLogEvents(${logGroup}))`({
            policyStatements: [
              {
                // PutLogEvents authorizes against the log-stream resource
                // (`log-group:{name}:log-stream:{stream}`), covered by the
                // `:*` wildcard on the group ARN.
                Effect: "Allow",
                Action: ["logs:PutLogEvents"],
                Resource: [Output.interpolate`${logGroup.logGroupArn}:*`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.Logs.PutLogEvents(${logGroup.LogicalId})`)(
        function* (request: PutLogEventsRequest) {
          const logGroupName = yield* LogGroupName;
          return yield* putLogEvents({
            ...request,
            logGroupName,
          });
        },
      );
    });
  }),
);
