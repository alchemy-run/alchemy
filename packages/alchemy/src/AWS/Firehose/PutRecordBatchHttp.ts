import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";
import {
  PutRecordBatch,
  type PutRecordBatchRequest,
} from "./PutRecordBatch.ts";

export const PutRecordBatchHttp = Layer.effect(
  PutRecordBatch,
  Effect.gen(function* () {
    const putRecordBatch = yield* Firehose.putRecordBatch;

    return Effect.fn(function* (deliveryStream: DeliveryStream) {
      const DeliveryStreamName = yield* deliveryStream.deliveryStreamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
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
