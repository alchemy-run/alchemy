import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { StateMachine } from "./StateMachine.ts";
import { StopExecution, type StopExecutionRequest } from "./StopExecution.ts";

const executionArnPattern = (stateMachine: StateMachine) =>
  Output.map(
    stateMachine.stateMachineArn,
    (arn) => `${arn.replace(":stateMachine:", ":execution:")}:*`,
  );

export const StopExecutionHttp = Layer.effect(
  StopExecution,
  Effect.gen(function* () {
    const stopExecution = yield* sfn.stopExecution;

    return Effect.fn(function* (stateMachine: StateMachine) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.StopExecution(${stateMachine}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:StopExecution"],
                  Resource: [executionArnPattern(stateMachine)],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.StepFunctions.StopExecution(${stateMachine.LogicalId})`,
      )(function* (request: StopExecutionRequest) {
        return yield* stopExecution(request);
      });
    });
  }),
);
