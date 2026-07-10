import * as sfn from "@distilled.cloud/aws/sfn";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeExecution,
  type DescribeExecutionRequest,
} from "./DescribeExecution.ts";
import type { StateMachine } from "./StateMachine.ts";

/**
 * Execution ARNs replace the `:stateMachine:` segment with `:execution:`
 * and append the execution name — grant on the machine's execution ARN
 * pattern.
 */
const executionArnPattern = (stateMachine: StateMachine) =>
  Output.map(
    stateMachine.stateMachineArn,
    (arn) => `${arn.replace(":stateMachine:", ":execution:")}:*`,
  );

export const DescribeExecutionHttp = Layer.effect(
  DescribeExecution,
  Effect.gen(function* () {
    const describeExecution = yield* sfn.describeExecution;

    return Effect.fn(function* (stateMachine: StateMachine) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.StepFunctions.DescribeExecution(${stateMachine}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["states:DescribeExecution"],
                  Resource: [executionArnPattern(stateMachine)],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.StepFunctions.DescribeExecution(${stateMachine.LogicalId})`,
      )(function* (request: DescribeExecutionRequest) {
        return yield* describeExecution(request);
      });
    });
  }),
);
