import * as agentcore from "@distilled.cloud/aws/bedrock-agentcore";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  RetrieveMemoryRecords,
  type RetrieveMemoryRecordsRequest,
} from "./RetrieveMemoryRecords.ts";
import type { Memory } from "./Memory.ts";

export const RetrieveMemoryRecordsHttp = Layer.effect(
  RetrieveMemoryRecords,
  Effect.gen(function* () {
    const retrieveMemoryRecords = yield* agentcore.retrieveMemoryRecords;

    return Effect.fn(function* <R extends Memory>(memory: R) {
      const Identifier = yield* memory.memoryId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.BedrockAgentCore.RetrieveMemoryRecords(${memory}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock-agentcore:RetrieveMemoryRecords"],
                  Resource: [memory.memoryArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.BedrockAgentCore.RetrieveMemoryRecords(${memory.LogicalId})`,
      )(function* (request: RetrieveMemoryRecordsRequest) {
        return yield* retrieveMemoryRecords({
          ...request,
          memoryId: yield* Identifier,
        });
      });
    });
  }),
);
