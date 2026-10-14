import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toWireSeconds } from "../../Util/Duration.ts";
import * as HostAccess from "../HostAccess.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";
import {
  StartCodeInterpreterSession,
  type StartCodeInterpreterSessionRequest,
} from "./StartCodeInterpreterSession.ts";

// Bespoke (not the shared scaffold): converts the ergonomic `sessionTimeout`
// Duration.Input to the wire `sessionTimeoutSeconds` field.
export const StartCodeInterpreterSessionHttp = Layer.effect(
  StartCodeInterpreterSession,
  Effect.gen(function* () {
    const startCodeInterpreterSession = yield* HostAccess.withCredentials(
      agentcore.startCodeInterpreterSession,
    );

    return Effect.fn(function* <R extends CodeInterpreter>(codeInterpreter: R) {
      const Identifier = yield* codeInterpreter.codeInterpreterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.BedrockAgentCore.StartCodeInterpreterSession(${codeInterpreter})`(
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
      return Effect.fn(
        `AWS.BedrockAgentCore.StartCodeInterpreterSession(${codeInterpreter.LogicalId})`,
      )(function* ({ sessionTimeout, ...request }: StartCodeInterpreterSessionRequest) {
        return yield* startCodeInterpreterSession({
          ...request,
          sessionTimeoutSeconds: toWireSeconds(sessionTimeout),
          codeInterpreterIdentifier: yield* Identifier,
        });
      });
    });
  }),
);
