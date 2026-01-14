import type {
  Context as LambdaContext,
  KinesisStreamBatchResponse,
  KinesisStreamEvent,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { declare, type From } from "../../policy.ts";
import * as Lambda from "./function.ts";
import type { Stream } from "../kinesis/stream.ts";
import type { Consume, StreamEvent } from "../kinesis/stream.consume.ts";
import {
  StreamEventSource,
  type StreamEventSourceProps,
} from "../kinesis/stream.event-source.ts";

export const consumeStream =
  <K extends Stream, ID extends string, Req>(
    id: ID,
    {
      stream,
      handle,
      ...eventSourceProps
    }: {
      stream: K;
      handle: (
        event: StreamEvent<K["props"]["schema"]["Type"]>,
        context: LambdaContext,
      ) => Effect.Effect<KinesisStreamBatchResponse | void, never, Req>;
    } & StreamEventSourceProps,
  ) =>
  <const Props extends Lambda.FunctionProps<Req>>({
    bindings,
    ...props
  }: Props) =>
    Lambda.Function(id, {
      handle: Effect.fn(function* (
        event: KinesisStreamEvent,
        context: LambdaContext,
      ) {
        yield* declare<Consume<From<K>>>();
        const records = yield* Effect.all(
          event.Records.map(
            Effect.fn(function* (record) {
              // Decode the Kinesis data from base64
              const decodedData = Buffer.from(
                record.kinesis.data,
                "base64",
              ).toString("utf-8");
              let parsedData: unknown;
              try {
                parsedData = JSON.parse(decodedData);
              } catch {
                // If not JSON, use raw string
                parsedData = decodedData;
              }

              const validatedData = yield* S.validate(stream.props.schema)(
                parsedData,
              ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

              return {
                ...record,
                kinesis: {
                  ...record.kinesis,
                  data: validatedData,
                },
              };
            }),
          ),
        );

        const validRecords = records.filter(
          (record) => record.kinesis.data !== undefined,
        );
        const invalidRecords = records.filter(
          (record) => record.kinesis.data === undefined,
        );

        const response = yield* handle(
          {
            Records: validRecords as StreamEvent<
              K["props"]["schema"]["Type"]
            >["Records"],
          },
          context,
        );

        return {
          batchItemFailures: [
            ...(response?.batchItemFailures ?? []),
            ...invalidRecords.map((failed) => ({
              itemIdentifier: failed.kinesis.sequenceNumber,
            })),
          ],
        } satisfies KinesisStreamBatchResponse;
      }),
    })({
      ...props,
      bindings: bindings.and(StreamEventSource(stream, eventSourceProps)),
    });
