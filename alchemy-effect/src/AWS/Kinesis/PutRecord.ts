import * as Kinesis from "distilled-aws/kinesis";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { ExecutionContext } from "../../Executable.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordRequest extends Omit<
  Kinesis.PutRecordInput,
  "StreamName"
> {}

export class PutRecord extends Binding.Service<
  PutRecord,
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordRequest,
    ) => Effect.Effect<Kinesis.PutRecordOutput, Kinesis.PutRecordError>
  >
>()("AWS.Kinesis.PutRecord") {}

export const PutRecordLive = Layer.effect(
  PutRecord,
  Effect.gen(function* () {
    const Policy = yield* PutRecordPolicy;
    const putRecord = yield* Kinesis.putRecord;

    return Effect.fn(function* (stream: Stream) {
      const StreamName = yield* stream.streamName;
      yield* Policy(stream);
      return Effect.fn(function* (request: PutRecordRequest) {
        return yield* putRecord({
          ...request,
          StreamName: yield* StreamName,
        });
      });
    });
  }),
);

export class PutRecordPolicy extends Binding.Policy<
  PutRecordPolicy,
  (stream: Stream) => Effect.Effect<void>
>()("AWS.Kinesis.PutRecord") {}

export const PutRecordPolicyLive = Layer.effect(
  PutRecordPolicy,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return Effect.fn(function* (stream: Stream) {
      if (Lambda.isFunction(ctx)) {
        return yield* ctx.bind({
          policyStatements: [
            {
              Sid: "PutRecord",
              Effect: "Allow",
              Action: ["kinesis:PutRecord"],
              Resource: [Output.interpolate`${stream.streamArn}`],
            },
          ],
        });
      } else {
        return yield* Effect.die(
          `PutRecordPolicy does not support runtime '${ctx.type}'`,
        );
      }
    });
  }),
);
