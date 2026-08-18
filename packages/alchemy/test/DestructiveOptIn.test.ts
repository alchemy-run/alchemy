import { AlchemyContext } from "@/AlchemyContext.ts";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import {
  type Bucket as S3Bucket,
  BucketProvider as S3BucketProvider,
} from "@/AWS/S3/Bucket.ts";
import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthProvider.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { LocalRuntimeState } from "@/Cloudflare/LocalRuntime.ts";
import {
  type Bucket as R2Bucket,
  BucketProvider as R2BucketProvider,
} from "@/Cloudflare/R2/Bucket.ts";
import { InstanceId } from "@/InstanceId.ts";
import { Provider } from "@/Provider.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import {
  Credentials as AwsCredentials,
  fromCredentials as awsFromCredentials,
} from "@distilled.cloud/aws/Credentials";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import {
  apiTokenCredentials,
  Credentials as CloudflareCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";

/**
 * DATA-PROTECTION INVARIANT: a provider's `delete` may remove the resource
 * itself, but it must NEVER destroy the resource's CONTENTS unless the user
 * opted in on the resource (`forceDestroy`) or an operator ran
 * `alchemy unsafe nuke` (which passes `force: true`).
 *
 * Cloud APIs refuse to delete a non-empty container (S3 `BucketNotEmpty`,
 * R2's 409 "is not empty"). That refusal is the last line of defense for
 * production data, and a provider that empties the container first silently
 * converts a routine teardown into irreversible data loss — which is exactly
 * what happened in https://github.com/alchemy-run/alchemy/issues/1248, where
 * a stale removal policy orphaned a bucket and the delete wiped 60k objects
 * the API would otherwise have protected.
 *
 * A live test cannot pin this: it can only observe that a bucket survived,
 * not that no destructive request was ever issued. So these run the REAL
 * provider `delete` against a recording HTTP transport and assert on the
 * wire traffic — the emptying request must be absent without opt-in, and
 * present with it. Every provider whose delete has a destructive
 * prerequisite belongs in this file.
 */

type Recorded = { method: string; url: string };

/**
 * Fetch transport that records every request and answers from `respond`.
 * Returns the recorded calls so a test can assert on what was NOT sent.
 */
const recordingTransport = (
  respond: (call: Recorded) => Response = () =>
    new Response(JSON.stringify({ success: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
) => {
  const calls: Recorded[] = [];
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: Recorded = {
      method: (input instanceof Request ? input.method : init?.method) ?? "GET",
      url: input instanceof Request ? input.url : String(input),
    };
    calls.push(call);
    return respond(call);
  };
  return {
    calls,
    layer: FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      ),
    ),
  };
};

const INSTANCE_ID = "0123456789abcdef0123456789abcdef";

const stack: Omit<StackSpec, "output"> = {
  name: "my-stack",
  stage: "dev",
  resources: {},
  bindings: {},
  actions: {},
};

/** Services every provider layer needs, independent of the transport. */
const base = Layer.mergeAll(
  Layer.succeed(Stack, stack),
  Layer.succeed(Stage, stack.stage),
  Layer.succeed(InstanceId, INSTANCE_ID),
  Layer.succeed(AlchemyContext, {
    dotAlchemy: "/tmp/.alchemy-test",
    dev: false,
    adopt: false,
  }),
  Layer.sync(ArtifactStore, createArtifactStore),
  NodeServices.layer,
);

const session = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};

const deleteInput = <Olds, Output>(
  id: string,
  olds: Olds,
  output: Output,
  force?: boolean,
) => ({
  id,
  fqn: id,
  instanceId: INSTANCE_ID,
  olds: olds as never,
  output: output as never,
  bindings: [] as never,
  session,
  force,
});

// ── Cloudflare R2 ──────────────────────────────────────────────────────

const TEST_ACCOUNT = "test-account-id";

const cloudflareCredentials: CloudflareResolvedCredentials = {
  type: "apiToken",
  apiToken: Redacted.make("test-token"),
  accountId: TEST_ACCOUNT,
  source: { type: "env" },
};

const cloudflareEnv = (transport: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.mergeAll(
    Layer.succeed(CloudflareEnvironment, Effect.succeed(cloudflareCredentials)),
    Layer.succeed(
      CloudflareCredentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
    Layer.succeed(
      LocalRuntimeState,
      LocalRuntimeState.of({
        queues: MutableHashMap.empty(),
        queueConsumers: MutableHashMap.empty(),
        workerRestarts: MutableHashMap.empty(),
      }),
    ),
    base,
  ).pipe(Layer.provideMerge(transport));

const r2Output = {
  bucketName: "my-bucket",
  storageClass: "Standard" as const,
  jurisdiction: "default" as const,
  location: undefined,
  accountId: TEST_ACCOUNT,
  domains: [],
  lifecycleRules: [],
  cors: [],
};

/** `DELETE .../r2/buckets/{name}/objects` — the request that wipes data. */
const r2ObjectDeletes = (calls: Recorded[]) =>
  calls.filter((c) => c.method === "DELETE" && c.url.includes("/objects"));

/** `DELETE .../r2/buckets/{name}` — deleting the bucket itself. */
const r2BucketDeletes = (calls: Recorded[]) =>
  calls.filter(
    (c) =>
      c.method === "DELETE" &&
      c.url.endsWith(`/r2/buckets/${r2Output.bucketName}`),
  );

/** One object in the bucket, so the empty path has something to delete. */
const r2Respond = (call: Recorded) =>
  new Response(
    JSON.stringify(
      call.url.includes("/objects") && call.method === "GET"
        ? { success: true, result: [{ key: "precious.txt" }] }
        : { success: true, result: {} },
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const deleteR2Bucket = (
  props: { forceDestroy?: boolean },
  options?: { force?: boolean },
) =>
  Effect.gen(function* () {
    const transport = recordingTransport(r2Respond);
    yield* Effect.gen(function* () {
      const provider = yield* Provider<R2Bucket>("Cloudflare.R2.Bucket");
      yield* provider.delete(
        deleteInput("Bucket", props, r2Output, options?.force),
      );
    }).pipe(
      Effect.provide(R2BucketProvider()),
      Effect.provide(cloudflareEnv(transport.layer)),
    );
    return transport.calls;
  });

// ── AWS S3 ─────────────────────────────────────────────────────────────

// Credentials are built with distilled's own helper: the signer reads them
// through distilled's copy of `effect`, whose `Redacted` values a
// `Redacted.make` from this package's copy cannot unwrap.
const AWS_REGION = "us-east-1";

const awsCredentials = awsFromCredentials(
  { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "test-secret-key" },
  AWS_REGION,
);

const awsEnv = (transport: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.mergeAll(
    Layer.effect(
      AWSEnvironment,
      Effect.map(AwsCredentials, (credentials) =>
        Effect.succeed({
          accountId: "123456789012",
          region: AWS_REGION,
          credentials,
        } as never),
      ),
    ).pipe(Layer.provide(awsCredentials)),
    awsCredentials,
    Layer.succeed(AwsRegion, Effect.succeed(AWS_REGION)),
    base,
  ).pipe(Layer.provideMerge(transport));

const s3Output = {
  bucketName: "my-bucket",
  arn: "arn:aws:s3:::my-bucket",
  region: AWS_REGION,
  bucketDomainName: "my-bucket.s3.amazonaws.com",
  bucketRegionalDomainName: "my-bucket.s3.us-east-1.amazonaws.com",
  hostedZoneId: "Z3AQBSTGFYJSTF",
  tags: {},
};

/** `POST /?delete` — S3's bulk object/version delete. */
const s3ObjectDeletes = (calls: Recorded[]) =>
  calls.filter((c) => c.method === "POST" && /[?&]delete/.test(c.url));

/** `GET /?versions` — enumerating what to wipe. */
const s3VersionListings = (calls: Recorded[]) =>
  calls.filter((c) => c.method === "GET" && /[?&]versions/.test(c.url));

const s3BucketDeletes = (calls: Recorded[]) =>
  calls.filter((c) => c.method === "DELETE" && !/[?&]/.test(c.url));

/** One object version, so the empty path has something to delete. */
const s3Respond = (call: Recorded) =>
  /[?&]versions/.test(call.url)
    ? new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
         <ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
           <Name>my-bucket</Name>
           <IsTruncated>false</IsTruncated>
           <Version>
             <Key>precious.txt</Key>
             <VersionId>null</VersionId>
           </Version>
         </ListVersionsResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      )
    : new Response("", {
        status: 204,
        headers: { "content-type": "application/xml" },
      });

const deleteS3Bucket = (
  props: { forceDestroy?: boolean },
  options?: { force?: boolean },
) =>
  Effect.gen(function* () {
    const transport = recordingTransport(s3Respond);
    yield* Effect.gen(function* () {
      const provider = yield* Provider<S3Bucket>("AWS.S3.Bucket");
      yield* provider.delete(
        deleteInput("Bucket", props, s3Output, options?.force),
      );
    }).pipe(
      Effect.provide(S3BucketProvider()),
      Effect.provide(awsEnv(transport.layer)),
    );
    return transport.calls;
  });

describe("destructive deletes require explicit opt-in", () => {
  it.effect("R2 Bucket: no forceDestroy never empties the bucket", () =>
    Effect.gen(function* () {
      const calls = yield* deleteR2Bucket({});

      expect(r2ObjectDeletes(calls)).toEqual([]);
      // The bucket delete itself is still attempted — R2 answers 409
      // "is not empty" (typed `BucketNotEmpty`), which is the protection.
      expect(r2BucketDeletes(calls)).toHaveLength(1);
    }),
  );

  it.effect("R2 Bucket: forceDestroy empties the bucket first", () =>
    Effect.gen(function* () {
      const calls = yield* deleteR2Bucket({ forceDestroy: true });

      expect(r2ObjectDeletes(calls).length).toBeGreaterThan(0);
      expect(r2BucketDeletes(calls)).toHaveLength(1);
    }),
  );

  it.effect("R2 Bucket: nuke's force empties without the prop", () =>
    // Nuke enumerates buckets from the cloud, so `olds` carries Attributes
    // and never has `forceDestroy` — the operator's confirmation is the
    // `force` flag itself.
    Effect.gen(function* () {
      const calls = yield* deleteR2Bucket({}, { force: true });

      expect(r2ObjectDeletes(calls).length).toBeGreaterThan(0);
    }),
  );

  it.effect("S3 Bucket: no forceDestroy never empties the bucket", () =>
    Effect.gen(function* () {
      const calls = yield* deleteS3Bucket({});

      expect(s3ObjectDeletes(calls)).toEqual([]);
      expect(s3VersionListings(calls)).toEqual([]);
      expect(s3BucketDeletes(calls).length).toBeGreaterThan(0);
    }),
  );

  it.effect("S3 Bucket: forceDestroy empties the bucket first", () =>
    Effect.gen(function* () {
      const calls = yield* deleteS3Bucket({ forceDestroy: true });

      expect(s3ObjectDeletes(calls).length).toBeGreaterThan(0);
      expect(s3BucketDeletes(calls).length).toBeGreaterThan(0);
    }),
  );

  it.effect("S3 Bucket: nuke's force empties without the prop", () =>
    Effect.gen(function* () {
      const calls = yield* deleteS3Bucket({}, { force: true });

      expect(s3ObjectDeletes(calls).length).toBeGreaterThan(0);
    }),
  );
});
