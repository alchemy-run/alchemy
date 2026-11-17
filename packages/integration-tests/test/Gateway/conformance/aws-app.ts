import * as AWS from "@alchemy.run/aws";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/** The bucket the AWS conformance program reads and writes. */
export const Objects = AWS.S3.Bucket("GatewayObjects", { forceDestroy: true });

/**
 * The program of a gatewayed sandbox that runs on AWS. Its S3 bindings are
 * granted on the gateway's role, so the program writes and reads an object
 * through them, and is refused when it calls S3 as itself.
 */
export const awsApp = Effect.gen(function* () {
  const bucket = yield* Objects;
  const put = yield* AWS.S3.PutObject(bucket);
  const get = yield* AWS.S3.GetObject(bucket);
  const bucketName = yield* bucket.bucketName;
  // What the sandbox itself can sign with: its own role.
  const own = Layer.mergeAll(Credentials.fromEnv(), Region.fromEnv(), FetchHttpClient.layer);
  return {
    fetch: Effect.gen(function* () {
      yield* put({ Key: "note.txt", Body: "written through the gateway" });
      const object = yield* get({ Key: "note.txt" });
      // The body is streamed from S3 through the gateway.
      const body = yield* object.Body!.pipe(Stream.decodeText, Stream.mkString);
      const direct = yield* S3.getObject({ Bucket: yield* bucketName, Key: "note.txt" }).pipe(
        Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "allowed" }),
        Effect.provide(own),
      );
      return yield* HttpServerResponse.json({
        body,
        contentLength: object.ContentLength,
        direct,
        gateway: (yield* Effect.sync(() => process.env)).ALCHEMY_GATEWAY_URL ?? null,
      });
    }).pipe(
      // Say why, so a failing platform's test shows the cause.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
});

/** The program's bindings, built on a Lambda Web Function gateway. */
export const AwsGateway = Layer.mergeAll(AWS.S3.PutObjectHttp, AWS.S3.GetObjectHttp).pipe(
  Layer.provide(AWS.Lambda.SandboxGateway),
);

/** What {@link awsApp} answers. */
export interface AwsServed {
  readonly body: string;
  readonly contentLength: number;
  readonly direct: string;
  readonly gateway: string | null;
}
