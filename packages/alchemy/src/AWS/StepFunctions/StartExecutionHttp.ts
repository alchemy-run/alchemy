import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  StartExecution,
  type StartExecutionRequest,
} from "./StartExecution.ts";
import type { StateMachine } from "./StateMachine.ts";

export const StartExecutionHttp = Layer.effect(
  StartExecution,
  Effect.gen(function* () {
    const startExecution = yield* sfn.startExecution;

    return Effect.fn(function* (stateMachine: StateMachine) {
      const StateMachineArn = yield* stateMachine.stateMachineArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.StartExecution(${stateMachine}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:StartExecution"],
                  Resource: [stateMachine.stateMachineArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.StepFunctions.StartExecution(${stateMachine.LogicalId})`,
      )(function* (request?: StartExecutionRequest) {
        const stateMachineArn = yield* StateMachineArn;
        return yield* startExecution({ ...request, stateMachineArn });
      });
    });
  }),
);
