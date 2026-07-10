import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Activity } from "./Activity.ts";
import {
  SendTaskSuccess,
  type SendTaskSuccessRequest,
} from "./SendTaskSuccess.ts";

export const SendTaskSuccessHttp = Layer.effect(
  SendTaskSuccess,
  Effect.gen(function* () {
    const sendTaskSuccess = yield* sfn.sendTaskSuccess;

    return Effect.fn(function* (activity?: Activity) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.SendTaskSuccess(${activity ?? "*"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:SendTaskSuccess"],
                  // Task tokens from `.waitForTaskToken` service
                  // integrations carry no IAM resource; only Activity
                  // tasks support resource-level scoping.
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
        `AWS.StepFunctions.SendTaskSuccess(${activity?.LogicalId})`,
      )(function* (request: SendTaskSuccessRequest) {
        return yield* sendTaskSuccess(request);
      });
    });
  }),
);
