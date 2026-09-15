import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Bucket, BucketProvider } from "@/AWS/S3/Bucket.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as Provider from "@/Provider.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { Retry } from "@distilled.cloud/aws/Retry";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

export const accountId = "123456789012";
export const bucketName = "alchemy-bucket-provider-test";
export const instanceId = "0123456789abcdef0123456789abcdef";

export const output: Bucket["Attributes"] = {
  accountId,
  bucketName,
  bucketArn: `arn:aws:s3:::${bucketName}`,
  bucketDomainName: `${bucketName}.s3.amazonaws.com`,
  bucketRegionalDomainName: `${bucketName}.s3.us-east-1.amazonaws.com`,
  region: "us-east-1",
};

export const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

export interface Call {
  request: HttpClientRequest.HttpClientRequest;
  method: string;
  query: URLSearchParams;
  body: string;
}

export const xml = (body: string, status = 200) =>
  Effect.sync(
    () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/xml" },
      }),
  );

export const error = (code: string, status: number) =>
  xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);

/** Inject only the HTTP boundary; signing, XML codecs and providers stay real. */
export const fixture = (
  respond: (
    call: Call,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
  region = "us-east-1",
) => {
  const calls: Call[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const call = yield* Effect.sync(() => ({
        request,
        method: request.method,
        query: url.searchParams,
        body:
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : "",
      }));
      calls.push(call);
      return HttpClientResponse.fromWeb(request, yield* respond(call));
    }),
  );
  const credentials = fromCredentials(
    {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "test-secret-key",
    },
    region,
  );
  const environment = Layer.mergeAll(
    credentials,
    Layer.succeed(Region, Effect.succeed(region)),
    Layer.effect(
      AWSEnvironment,
      Effect.map(Credentials, (credentials) =>
        Effect.succeed({ accountId, region, credentials }),
      ),
    ).pipe(Layer.provide(credentials)),
    Layer.succeed(Stack, {
      name: "bucket-provider-test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, "test"),
    Layer.succeed(InstanceId, instanceId),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Retry, { while: () => false }),
  );
  return { calls, environment };
};

export const bucketProvider = Provider.Provider<Bucket>("AWS.S3.Bucket");

export const provideBucket = <A, E>(
  operation: Effect.Effect<A, E, Provider.Provider<Bucket>>,
  environment: ReturnType<typeof fixture>["environment"],
) =>
  operation.pipe(Effect.provide(BucketProvider()), Effect.provide(environment));

/** Responses for configuration outside the aspect under examination. */
export const existingBucket = (call: Call) => {
  if (call.method === "HEAD") return xml("");
  if (call.query.has("location")) return xml("<LocationConstraint/>");
  if (call.query.has("tagging")) return xml("<Tagging><TagSet/></Tagging>");
  if (call.query.has("policy")) return error("NoSuchBucketPolicy", 404);
  return Effect.die(
    `Unexpected S3 request: ${call.method} ${call.request.url}`,
  );
};

export const existingStateBucket = (call: Call) => {
  if (call.query.has("versioning")) {
    return xml(
      "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    );
  }
  if (call.query.has("publicAccessBlock")) {
    return xml(
      "<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>",
    );
  }
  if (call.query.has("ownershipControls")) {
    return xml(
      "<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>",
    );
  }
  if (call.query.has("list-type")) {
    return xml(
      "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
    );
  }
  return existingBucket(call);
};
