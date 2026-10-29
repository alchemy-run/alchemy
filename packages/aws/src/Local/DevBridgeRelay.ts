import * as lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sqs from "@distilled.cloud/aws/sqs";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AwsAuth } from "../AuthProvider.ts";
import * as Credentials from "../Credentials.ts";
import * as Endpoint from "../Endpoint.ts";
import { Default as DefaultEnvironment } from "../Environment.ts";
import * as Region from "../Region.ts";

/** What the stub sends for each invocation (see `Lambda/dev-stub/index.mjs`). */
const BridgeRequest = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    deadline: Schema.Number,
    payload: Schema.optional(Schema.String),
    payloadKey: Schema.optional(Schema.String),
  }),
);

/**
 * The developer's real-cloud context, from their profile: the ambient AWS
 * environment in `alchemy dev` is the emulator.
 */
const developerCloud = Layer.mergeAll(
  Region.fromEnvironment,
  Credentials.fromEnvironment,
  Endpoint.fromEnvironment,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
);

/**
 * Carry invocations from a stub Lambda in the real cloud to the emulated
 * Function it stands in for, until interrupted: receive each from the
 * bridge queue, invoke `functionName()` on the emulator (`emulator`), and
 * write the result to `responses/<id>.json` in the bridge bucket, where the
 * stub waits for it.
 */
export const relayDevBridge = (options: {
  queueUrl: string;
  bucket: string;
  /** The emulated Function's name, read per invocation (it survives reloads). */
  functionName: () => string;
  emulator: Layer.Layer<any>;
}) =>
  Effect.gen(function* () {
    const cloud = yield* Layer.build(developerCloud);
    const inCloud = <A, E>(effect: Effect.Effect<A, E, any>) =>
      effect.pipe(Effect.provideContext(cloud)) as Effect.Effect<A, E>;

    const forward = Effect.fn(function* (message: sqs.Message) {
      const request = yield* Schema.decodeUnknownEffect(BridgeRequest)(message.Body);
      if ((yield* Clock.currentTimeMillis) < request.deadline) {
        const payload =
          request.payload ??
          (yield* inCloud(
            s3
              .getObject({ Bucket: options.bucket, Key: request.payloadKey! })
              .pipe(Effect.flatMap(({ Body }) => Body!.pipe(Stream.decodeText, Stream.mkString))),
          ));
        const result = yield* lambda
          .invoke({ FunctionName: options.functionName(), Payload: payload })
          .pipe(Effect.provide(options.emulator));
        const output =
          result.Payload === undefined
            ? undefined
            : yield* result.Payload.pipe(Stream.decodeText, Stream.mkString);
        const response =
          result.FunctionError !== undefined
            ? { error: errorOf(result.FunctionError, output) }
            : { payload: output === "" || output === "null" ? undefined : output };
        yield* inCloud(
          s3.putObject({
            Bucket: options.bucket,
            Key: `responses/${request.id}.json`,
            Body: JSON.stringify(response),
          }),
        );
      }
      yield* inCloud(
        sqs.deleteMessage({ QueueUrl: options.queueUrl, ReceiptHandle: message.ReceiptHandle! }),
      );
    });

    const receive = inCloud(
      sqs.receiveMessage({
        QueueUrl: options.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      }),
    ).pipe(
      Effect.flatMap(({ Messages }) =>
        Effect.forEach(
          Messages ?? [],
          (message) =>
            forward(message).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("[alchemy dev] failed to forward a real-cloud event", cause),
              ),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("[alchemy dev] failed to receive real-cloud events", cause).pipe(
          Effect.andThen(Effect.sleep("5 seconds")),
        ),
      ),
    );
    return yield* Effect.forever(receive);
  }).pipe(Effect.scoped);

/** A Lambda function error, in the shape the stub rethrows. */
const errorOf = (functionError: string, output: string | undefined) => {
  try {
    const parsed = JSON.parse(output ?? "{}") as { errorType?: string; errorMessage?: string };
    return {
      type: parsed.errorType ?? functionError,
      message: parsed.errorMessage ?? output ?? "",
    };
  } catch {
    return { type: functionError, message: output ?? "" };
  }
};
