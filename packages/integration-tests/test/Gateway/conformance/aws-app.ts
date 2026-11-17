import * as AWS from "@alchemy.run/aws";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
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
  const presign = yield* AWS.S3.PresignGetObject(bucket);
  const bucketName = yield* bucket.bucketName;
  // What the sandbox itself can sign with: its own role.
  const own = Layer.mergeAll(Credentials.fromEnv(), Region.fromEnv(), FetchHttpClient.layer);
  return {
    fetch: Effect.gen(function* () {
      // The hosts this sandbox sends requests to while it serves this one.
      const hosts = new Set<string>();
      const original = globalThis.fetch;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          globalThis.fetch = ((input: any, init?: any) => {
            hosts.add(new URL(typeof input === "string" ? input : (input.url ?? input)).host);
            return original(input, init);
          }) as typeof fetch;
        }),
        () => Effect.sync(() => void (globalThis.fetch = original)),
      );
      yield* put({ Key: "note.txt", Body: "written through the gateway" });
      const object = yield* get({ Key: "note.txt" });
      // The body is streamed from S3 through the gateway.
      const body = yield* object.Body!.pipe(Stream.decodeText, Stream.mkString);
      const direct = yield* S3.getObject({ Bucket: yield* bucketName, Key: "note.txt" }).pipe(
        Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "allowed" }),
        Effect.provide(own),
      );
      // 1 MiB of bytes up, and streamed back down in pieces, through the
      // gateway.
      yield* put({ Key: "bytes.bin", Body: new Uint8Array(1024 * 1024).fill(7) });
      const streamed = yield* (yield* get({ Key: "bytes.bin" })).Body!.pipe(
        Stream.runFold(
          () => 0,
          (bytes, part) => bytes + part.length,
        ),
      );
      // The gateway signs the URL; the sandbox downloads straight from S3.
      const signed = yield* presign({ key: "note.txt" });
      const client = yield* HttpClient.HttpClient;
      const downloaded = yield* client.get(signed).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(FetchHttpClient.layer),
      );
      return yield* HttpServerResponse.json({
        streamed,
        hosts: [...hosts],
        presignedHost: new URL(signed).host,
        downloaded,
        body,
        contentLength: object.ContentLength,
        direct,
        gateway: (yield* Effect.sync(() => process.env)).ALCHEMY_GATEWAY_URL ?? null,
      });
    }).pipe(
      Effect.scoped,
      // Say why, so a failing platform's test shows the cause.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
});

/** The program's bindings, built on a Lambda Web Function gateway. */
export const AwsGateway = Layer.mergeAll(
  AWS.S3.PutObjectHttp,
  AWS.S3.GetObjectHttp,
  AWS.S3.PresignGetObjectHttp,
).pipe(Layer.provide(AWS.Lambda.SandboxGateway));

/** What {@link awsApp} answers. */
export interface AwsServed {
  /** Every host the sandbox itself sent a request to. */
  readonly hosts: ReadonlyArray<string>;
  readonly streamed: number;
  readonly presignedHost: string;
  readonly downloaded: string;
  readonly body: string;
  readonly contentLength: number;
  readonly direct: string;
  readonly gateway: string | null;
}

/**
 * The same bindings, built in the sandbox: the gateway only signs, and the
 * sandbox sends its requests to S3 itself.
 */
export const AwsSignedGateway = Layer.mergeAll(
  AWS.S3.PutObjectHttp,
  AWS.S3.GetObjectHttp,
  AWS.S3.PresignGetObjectHttp,
).pipe(Layer.provide(AWS.SandboxSigner), Layer.provide(AWS.Lambda.SandboxGateway));
