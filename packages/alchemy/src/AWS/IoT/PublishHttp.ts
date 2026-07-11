import * as iotdata from "@distilled.cloud/aws/iot-data-plane";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Publish, type PublishRequest } from "./Publish.ts";

/**
 * HTTP implementation of the {@link Publish} capability.
 *
 * At deploy time it attaches an IAM policy statement granting `iot:Publish`
 * on the bound topic filter (`arn:aws:iot:...:topic/{filter}`); at runtime it
 * calls the IoT data-plane `Publish` API over HTTPS.
 *
 * @example Provide the layer on a Lambda Function
 * ```typescript
 * export default TelemetryFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const publish = yield* AWS.IoT.Publish("sensors/*");
 *     // ... handlers that call `publish({ topic, payload })`
 *   }).pipe(Effect.provide(AWS.IoT.PublishHttp)),
 * );
 * ```
 */
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
