import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";
import {
  PutRecordBatch,
  type PutRecordBatchRequest,
} from "./PutRecordBatch.ts";

/**
 * HTTP implementation of {@link PutRecordBatch}. At deploy time it grants
 * `firehose:PutRecordBatch` on the bound delivery stream; at runtime it calls
 * the Firehose API with the host Function's credentials. Provide this layer
 * on the Function using the binding.
 */
export const PutRecordBatchHttp = Layer.effect(
  PutRecordBatch,
  Effect.gen(function* () {
    const putRecordBatch = yield* Firehose.putRecordBatch;

    return Effect.fn(function* (deliveryStream: DeliveryStream) {
      const DeliveryStreamName = yield* deliveryStream.deliveryStreamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Firehose.PutRecordBatch(${deliveryStream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["firehose:PutRecordBatch"],
                  Resource: [
                    Output.interpolate`${deliveryStream.deliveryStreamArn}`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Firehose.PutRecordBatch(${deliveryStream.LogicalId})`,
      )(function* (request: PutRecordBatchRequest) {
        return yield* putRecordBatch({
          ...request,
          DeliveryStreamName: yield* DeliveryStreamName,
        });
      });
    });
  }),
);
