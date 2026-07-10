import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Activity } from "./Activity.ts";
import {
  SendTaskHeartbeat,
  type SendTaskHeartbeatRequest,
} from "./SendTaskHeartbeat.ts";

export const SendTaskHeartbeatHttp = Layer.effect(
  SendTaskHeartbeat,
  Effect.gen(function* () {
    const sendTaskHeartbeat = yield* sfn.sendTaskHeartbeat;

    return Effect.fn(function* (activity?: Activity) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.SendTaskHeartbeat(${activity ?? "*"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:SendTaskHeartbeat"],
                  Resource: [
                    activity
                      ? Output.interpolate`${activity.activityArn}`
                      : "*",
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.StepFunctions.SendTaskHeartbeat(${activity?.LogicalId})`,
      )(function* (request: SendTaskHeartbeatRequest) {
        return yield* sendTaskHeartbeat(request);
      });
    });
  }),
);
