import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { CreateEvent, type CreateEventRequest } from "./CreateEvent.ts";
import type { Memory } from "./Memory.ts";

export const CreateEventHttp = Layer.effect(
  CreateEvent,
  Effect.gen(function* () {
    const createEvent = yield* agentcore.createEvent;

    return Effect.fn(function* <R extends Memory>(memory: R) {
      const Identifier = yield* memory.memoryId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.CreateEvent(${memory}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:CreateEvent"],
                  Resource: [memory.memoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.BedrockAgentCore.CreateEvent(${memory.LogicalId})`)(
        function* (request: CreateEventRequest) {
          return yield* createEvent({
            ...request,
            memoryId: yield* Identifier,
          });
        },
      );
    });
  }),
);
