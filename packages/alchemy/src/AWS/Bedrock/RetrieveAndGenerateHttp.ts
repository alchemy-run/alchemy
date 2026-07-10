import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { bedrockModelArns } from "./ModelArns.ts";
import type { KnowledgeBase } from "./KnowledgeBase.ts";
import {
  RetrieveAndGenerate,
  type RetrieveAndGenerateRequest,
} from "./RetrieveAndGenerate.ts";

export const RetrieveAndGenerateHttp = Layer.effect(
  RetrieveAndGenerate,
  Effect.gen(function* () {
    const retrieveAndGenerate = yield* bedrock.retrieveAndGenerate;

    return Effect.fn(function* <K extends KnowledgeBase>(
      knowledgeBase: K,
      ...models: string[]
    ) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Scope InvokeModel to the named models, or all foundation models +
          // cross-region inference profiles when the caller names none.
          const modelResources =
            models.length > 0
              ? [
                  ...new Set(
                    models.flatMap((id) =>
                      bedrockModelArns(region, accountId, id),
                    ),
                  ),
                ]
              : [
                  `arn:aws:bedrock:${region}::foundation-model/*`,
                  `arn:aws:bedrock:${region}:${accountId}:inference-profile/*`,
                ];
          yield* host.bind`Allow(${host}, AWS.Bedrock.RetrieveAndGenerate(${knowledgeBase}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"],
                  Resource: [knowledgeBase.knowledgeBaseArn],
                },
                {
                  Effect: "Allow",
                  Action: ["bedrock:InvokeModel"],
                  Resource: modelResources,
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Bedrock.RetrieveAndGenerate(${knowledgeBase.LogicalId})`,
      )(function* (request: RetrieveAndGenerateRequest) {
        return yield* retrieveAndGenerate(request);
      });
    });
  }),
);
