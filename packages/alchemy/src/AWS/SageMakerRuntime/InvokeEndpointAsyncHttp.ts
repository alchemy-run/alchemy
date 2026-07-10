import * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  InvokeEndpointAsync,
  type InvokeEndpointAsyncRequest,
} from "./InvokeEndpointAsync.ts";

export const InvokeEndpointAsyncHttp = Layer.effect(
  InvokeEndpointAsync,
  Effect.gen(function* () {
    const invokeEndpointAsync = yield* sagemaker.invokeEndpointAsync;

    return Effect.fn(function* (
      endpoint: string,
      ...additionalEndpoints: string[]
    ) {
      const endpoints = [endpoint, ...additionalEndpoints];
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          const sorted = [...new Set(endpoints)].sort();
          yield* host.bind`Allow(${host}, AWS.SageMakerRuntime.InvokeEndpointAsync(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sagemaker:InvokeEndpointAsync"],
                  Resource: sorted.map(
                    (name) =>
                      `arn:aws:sagemaker:${region}:${accountId}:endpoint/${name}`,
                  ),
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.SageMakerRuntime.InvokeEndpointAsync(${endpoint})`)(
        function* (request: InvokeEndpointAsyncRequest) {
          return yield* invokeEndpointAsync({
            ...request,
            EndpointName: request.EndpointName ?? endpoint,
          });
        },
      );
    });
  }),
);
