import * as Firehose from "@distilled.cloud/aws/firehose";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";
import { PutRecord, type PutRecordRequest } from "./PutRecord.ts";

/**
 * HTTP implementation of {@link PutRecord}. At deploy time it grants
 * `firehose:PutRecord` on the bound delivery stream; at runtime it calls the
 * Firehose API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const PutRecordHttp = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const putRecord = yield* Firehose.putRecord;

    return Effect.fn(function* (deliveryStream: DeliveryStream) {
      const DeliveryStreamName = yield* deliveryStream.deliveryStreamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Firehose.PutRecord(${deliveryStream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["firehose:PutRecord"],
                  Resource: [
                    Output.interpolate`${deliveryStream.deliveryStreamArn}`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Firehose.PutRecord(${deliveryStream.LogicalId})`)(
        function* (request: PutRecordRequest) {
          return yield* putRecord({
            ...request,
            DeliveryStreamName: yield* DeliveryStreamName,
          });
        },
      );
    });
  }),
);
