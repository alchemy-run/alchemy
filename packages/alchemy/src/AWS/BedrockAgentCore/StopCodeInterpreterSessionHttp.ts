import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  StopCodeInterpreterSession,
  type StopCodeInterpreterSessionRequest,
} from "./StopCodeInterpreterSession.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const StopCodeInterpreterSessionHttp = Layer.effect(
  StopCodeInterpreterSession,
  Effect.gen(function* () {
    const stopCodeInterpreterSession =
      yield* agentcore.stopCodeInterpreterSession;

    return Effect.fn(function* <R extends CodeInterpreter>(codeInterpreter: R) {
      const Identifier = yield* codeInterpreter.codeInterpreterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.StopCodeInterpreterSession(${codeInterpreter}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:StopCodeInterpreterSession"],
                  Resource: [codeInterpreter.codeInterpreterArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.StopCodeInterpreterSession(${codeInterpreter.LogicalId})`,
      )(function* (request: StopCodeInterpreterSessionRequest) {
        return yield* stopCodeInterpreterSession({
          ...request,
          codeInterpreterIdentifier: yield* Identifier,
        });
      });
    });
  }),
);
