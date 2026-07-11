import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  InvokeCodeInterpreter,
  type InvokeCodeInterpreterRequest,
} from "./InvokeCodeInterpreter.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const InvokeCodeInterpreterHttp = Layer.effect(
  InvokeCodeInterpreter,
  Effect.gen(function* () {
    const invokeCodeInterpreter = yield* agentcore.invokeCodeInterpreter;

    return Effect.fn(function* <R extends CodeInterpreter>(codeInterpreter: R) {
      const Identifier = yield* codeInterpreter.codeInterpreterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.InvokeCodeInterpreter(${codeInterpreter}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:InvokeCodeInterpreter"],
                  Resource: [codeInterpreter.codeInterpreterArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.InvokeCodeInterpreter(${codeInterpreter.LogicalId})`,
      )(function* (request: InvokeCodeInterpreterRequest) {
        return yield* invokeCodeInterpreter({
          ...request,
          codeInterpreterIdentifier: yield* Identifier,
        });
      });
    });
  }),
);
