import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ListSessions, type ListSessionsRequest } from "./ListSessions.ts";
import type { Memory } from "./Memory.ts";

export const ListSessionsHttp = Layer.effect(
  ListSessions,
  Effect.gen(function* () {
    const listSessions = yield* agentcore.listSessions;

    return Effect.fn(function* <R extends Memory>(memory: R) {
      const Identifier = yield* memory.memoryId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.ListSessions(${memory}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:ListSessions"],
                  Resource: [memory.memoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.ListSessions(${memory.LogicalId})`,
      )(function* (request: ListSessionsRequest) {
        return yield* listSessions({
          ...request,
          memoryId: yield* Identifier,
        });
      });
    });
  }),
);
