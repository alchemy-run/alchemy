import type * as Firehose from "@distilled.cloud/aws/firehose";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import type { DeliveryStream } from "./DeliveryStream.ts";
import { PutRecordBatch } from "./PutRecordBatch.ts";

/**
 * The raw distilled `PutRecordBatch` entry. Callers stay in control of the
 * record payload (including any delimiters — Firehose does not add newlines
 * between records).
 */
export type DeliveryStreamSinkRecord = Firehose.Record;

export type DeliveryStreamSinkError =
  | Firehose.PutRecordBatchError
  | BatchRetryExhaustedError<DeliveryStreamSinkRecord>;

/**
 * A batching sink over Firehose `PutRecordBatch` (500 records / 4 MiB per
 * call).
 *
 * Each input element is a raw `Firehose.Record` (`{ Data: Uint8Array }`), so
 * callers stay in control of encoding and record framing.
 *
 * Even a 200 response can carry per-record failures (`FailedPutCount > 0`,
 * per-record `ErrorCode` — `ServiceUnavailableException` / internal failure).
 * All of them are transient, so the failed subset is re-submitted in input
 * order on a bounded schedule; exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded records.
 *
 * ### Streaming Records
 * **Example:** Run a Stream of Records into the Delivery Stream
 * ```typescript
 * // init — bind the sink (provide AWS.Firehose.DeliveryStreamSinkHttp on the Function)
 * const sink = yield* AWS.Firehose.DeliveryStreamSink(deliveryStream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime — stream newline-framed records into Firehose
 *     yield* Stream.fromIterable(lines).pipe(
 *       Stream.map((line) => ({
 *         Data: new TextEncoder().encode(`${line}\n`),
 *       })),
 *       Stream.run(sink),
 *     );
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface DeliveryStreamSink extends Binding.Service<
  DeliveryStreamSink,
  "AWS.Firehose.DeliveryStreamSink",
  (
    deliveryStream: DeliveryStream,
  ) => Effect.Effect<
    Sink.Sink<
      void,
      DeliveryStreamSinkRecord,
      readonly DeliveryStreamSinkRecord[],
      DeliveryStreamSinkError
    >
  >
> {}

export const DeliveryStreamSink = Binding.Service<DeliveryStreamSink>(
  "AWS.Firehose.DeliveryStreamSink",
);

/**
 * HTTP implementation of {@link DeliveryStreamSink}. At deploy time it grants
 * `firehose:PutRecordBatch` on the bound delivery stream; at runtime it
 * batches stream elements into `PutRecordBatch` calls (500 records / 4 MiB)
 * with bounded retry of transient per-record failures. Provide this layer on
 * the Function using the sink.
 */
export const DeliveryStreamSinkHttp = Layer.effect(
  DeliveryStreamSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putRecordBatch = yield* PutRecordBatch;

    return Effect.fn(function* (deliveryStream: DeliveryStream) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Firehose.DeliveryStreamSink(${deliveryStream})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["firehose:PutRecordBatch"],
              Resource: [Output.interpolate`${deliveryStream.deliveryStreamArn}`],
            },
          ],
        });
      }
      const send = yield* putRecordBatch(deliveryStream);
      return makeBatchedSink<
        DeliveryStreamSinkRecord,
        Firehose.PutRecordBatchOutput,
        Firehose.PutRecordBatchError
      >({
        maxRecords: 500,
        maxBytes: 4 * 1024 * 1024,
        sizeOf: (record) => record.Data.length,
        send: (batch) => send({ Records: [...batch] }),
        // PutRecordBatch failures are positional: RequestResponses[i] mirrors
        // the request order and carries an ErrorCode (ServiceUnavailable /
        // internal failure) — all transient, so re-submit them on the
        // bounded schedule.
        unprocessed: (out, batch) => {
          if (!out.FailedPutCount) {
            return [];
          }
          return batch.filter((_, index) => out.RequestResponses[index]?.ErrorCode !== undefined);
        },
      });
    });
  }),
);
