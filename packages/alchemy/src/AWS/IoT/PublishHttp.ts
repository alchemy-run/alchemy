import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Publish, type PublishRequest } from "./Publish.ts";

export const PublishHttp = Layer.effect(
  Publish,
  Effect.gen(function* () {
    const publish = yield* iotdata.publish;

    return Effect.fn(function* (topicFilter?: string) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          const resource = `arn:aws:iot:${region}:${accountId}:topic/${topicFilter ?? "*"}`;
          yield* host.bind`Allow(${host}, AWS.IoT.Publish(${topicFilter ?? "*"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["iot:Publish"],
                  Resource: [resource],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.IoT.Publish(${topicFilter ?? "*"})`)(function* (
        request: PublishRequest,
      ) {
        return yield* publish(request);
      });
    });
  }),
);
