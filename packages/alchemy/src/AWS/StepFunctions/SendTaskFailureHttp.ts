import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Activity } from "./Activity.ts";
import {
  SendTaskFailure,
  type SendTaskFailureRequest,
} from "./SendTaskFailure.ts";

export const SendTaskFailureHttp = Layer.effect(
  SendTaskFailure,
  Effect.gen(function* () {
    const sendTaskFailure = yield* sfn.sendTaskFailure;

    return Effect.fn(function* (activity?: Activity) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.SendTaskFailure(${activity ?? "*"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:SendTaskFailure"],
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
        `AWS.StepFunctions.SendTaskFailure(${activity?.LogicalId})`,
      )(function* (request: SendTaskFailureRequest) {
        return yield* sendTaskFailure(request);
      });
    });
  }),
);
