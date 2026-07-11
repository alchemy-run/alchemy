import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ListMemoryRecords,
  type ListMemoryRecordsRequest,
} from "./ListMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const ListMemoryRecordsHttp = Layer.effect(
  ListMemoryRecords,
  Effect.gen(function* () {
    const listMemoryRecords = yield* agentcore.listMemoryRecords;

    return Effect.fn(function* <R extends Memory>(memory: R) {
      const Identifier = yield* memory.memoryId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.ListMemoryRecords(${memory}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:ListMemoryRecords"],
                  Resource: [memory.memoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.ListMemoryRecords(${memory.LogicalId})`,
      )(function* (request: ListMemoryRecordsRequest) {
        return yield* listMemoryRecords({
          ...request,
          memoryId: yield* Identifier,
        });
      });
    });
  }),
);
