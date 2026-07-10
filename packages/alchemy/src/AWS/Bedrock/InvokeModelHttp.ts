import * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { InvokeModel, type InvokeModelRequest } from "./InvokeModel.ts";
import { bedrockModelArns } from "./ModelArns.ts";

export const InvokeModelHttp = Layer.effect(
  InvokeModel,
  Effect.gen(function* () {
    const invokeModel = yield* bedrock.invokeModel;

    return Effect.fn(function* (model: string, ...additionalModels: string[]) {
      const modelIds = [model, ...additionalModels];
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          // Sort so the binding identity (SID + ARN list) is deterministic
          // regardless of argument order.
          const sorted = [...new Set(modelIds)].sort();
          yield* host.bind`Allow(${host}, AWS.Bedrock.InvokeModel(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["bedrock:InvokeModel"],
                  Resource: [
                    ...new Set(
                      sorted.flatMap((id) =>
                        bedrockModelArns(region, accountId, id),
                      ),
                    ),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Bedrock.InvokeModel(${model})`)(function* (
        request: InvokeModelRequest,
      ) {
        return yield* invokeModel({
          ...request,
          modelId: request.modelId ?? model,
        });
      });
    });
  }),
);
