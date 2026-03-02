import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordsRequest extends Omit<
  Kinesis.PutRecordsInput,
  "StreamName"
> {}

export class PutRecords extends Binding.Service<
  PutRecords,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordsRequest,
    ) => Effect.Effect<Kinesis.PutRecordsOutput, Kinesis.PutRecordsError>
  >
>()("AWS.Kinesis.PutRecords") {}

export const PutRecordsLive = Layer.effect(
  PutRecords,
  Effect.gen(function* () {
    const Policy = yield* PutRecordsPolicy;
    const putRecords = yield* Kinesis.putRecords;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      yield* Policy(stream);
      return Effect.fn(function* (request: PutRecordsRequest) {
        return yield* putRecords({
          ...request,
          StreamName: yield* StreamName,
        });
      });
    });
  }),
);

export class PutRecordsPolicy extends Binding.Policy<
  PutRecordsPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.PutRecords") {}

export const PutRecordsPolicyLive = Layer.effect(
  PutRecordsPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (stream: Stream) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "PutRecords",
              Effect: "Allow",
              Action: ["kinesis:PutRecords"],
              Resource: [Output.interpolate`${stream.streamArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `PutRecordsPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
