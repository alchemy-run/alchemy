import * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  InvokeEndpoint,
  type InvokeEndpointRequest,
} from "./InvokeEndpoint.ts";

export const InvokeEndpointHttp = Layer.effect(
  InvokeEndpoint,
  Effect.gen(function* () {
    const invokeEndpoint = yield* sagemaker.invokeEndpoint;

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
          // Sort so the binding identity (SID + ARN list) is deterministic
          // regardless of argument order.
          const sorted = [...new Set(endpoints)].sort();
          yield* host.bind`Allow(${host}, AWS.SageMakerRuntime.InvokeEndpoint(${sorted.join(",")}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["sagemaker:InvokeEndpoint"],
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
      return Effect.fn(`AWS.SageMakerRuntime.InvokeEndpoint(${endpoint})`)(
        function* (request: InvokeEndpointRequest) {
          return yield* invokeEndpoint({
            ...request,
            EndpointName: request.EndpointName ?? endpoint,
          });
        },
      );
    });
  }),
);
