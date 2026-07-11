import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { ListEvents, type ListEventsRequest } from "./ListEvents.ts";
import type { Memory } from "./Memory.ts";

export const ListEventsHttp = Layer.effect(
  ListEvents,
  Effect.gen(function* () {
    const listEvents = yield* agentcore.listEvents;

    return Effect.fn(function* <R extends Memory>(memory: R) {
      const Identifier = yield* memory.memoryId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.ListEvents(${memory}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:ListEvents"],
                  Resource: [memory.memoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.BedrockAgentCore.ListEvents(${memory.LogicalId})`)(
        function* (request: ListEventsRequest) {
          return yield* listEvents({
            ...request,
            memoryId: yield* Identifier,
          });
        },
      );
    });
  }),
);
