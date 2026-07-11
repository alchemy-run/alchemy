import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  StartCodeInterpreterSession,
  type StartCodeInterpreterSessionRequest,
} from "./StartCodeInterpreterSession.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";

export const StartCodeInterpreterSessionHttp = Layer.effect(
  StartCodeInterpreterSession,
  Effect.gen(function* () {
    const startCodeInterpreterSession =
      yield* agentcore.startCodeInterpreterSession;

    return Effect.fn(function* <R extends CodeInterpreter>(codeInterpreter: R) {
      const Identifier = yield* codeInterpreter.codeInterpreterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.StartCodeInterpreterSession(${codeInterpreter}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:StartCodeInterpreterSession"],
                  Resource: [codeInterpreter.codeInterpreterArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.StartCodeInterpreterSession(${codeInterpreter.LogicalId})`,
      )(function* (request: StartCodeInterpreterSessionRequest) {
        return yield* startCodeInterpreterSession({
          ...request,
          codeInterpreterIdentifier: yield* Identifier,
        });
      });
    });
  }),
);
