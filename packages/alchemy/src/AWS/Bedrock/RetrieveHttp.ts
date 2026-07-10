import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";
import { Retrieve, type RetrieveRequest } from "./Retrieve.ts";

export const RetrieveHttp = Layer.effect(
  Retrieve,
  Effect.gen(function* () {
    const retrieve = yield* bedrock.retrieve;

    return Effect.fn(function* <K extends KnowledgeBase>(knowledgeBase: K) {
      const KnowledgeBaseId = yield* knowledgeBase.knowledgeBaseId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Bedrock.Retrieve(${knowledgeBase}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock:Retrieve"],
                  Resource: [knowledgeBase.knowledgeBaseArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Bedrock.Retrieve(${knowledgeBase.LogicalId})`)(
        function* (request: RetrieveRequest) {
          return yield* retrieve({
            ...request,
            knowledgeBaseId: yield* KnowledgeBaseId,
          });
        },
      );
    });
  }),
);
