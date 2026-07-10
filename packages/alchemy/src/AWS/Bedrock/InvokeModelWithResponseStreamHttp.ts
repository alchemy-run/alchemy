import * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  InvokeModelWithResponseStream,
  type InvokeModelWithResponseStreamRequest,
} from "./InvokeModelWithResponseStream.ts";
import { bedrockModelArns } from "./ModelArns.ts";

export const InvokeModelWithResponseStreamHttp = Layer.effect(
  InvokeModelWithResponseStream,
  Effect.gen(function* () {
    const invokeModelWithResponseStream =
      yield* bedrock.invokeModelWithResponseStream;

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
          yield* host.bind`Allow(${host}, AWS.Bedrock.InvokeModelWithResponseStream(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  // Streaming operations authorize against this action, not
                  // bedrock:InvokeModel.
                  Action: ["bedrock:InvokeModelWithResponseStream"],
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
      return Effect.fn(`AWS.Bedrock.InvokeModelWithResponseStream(${model})`)(
        function* (request: InvokeModelWithResponseStreamRequest) {
          return yield* invokeModelWithResponseStream({
            ...request,
            modelId: request.modelId ?? model,
          });
        },
      );
    });
  }),
);
