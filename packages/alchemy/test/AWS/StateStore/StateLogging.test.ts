import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { Credentials } from "@/AWS/Credentials.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { makeS3State } from "@/AWS/StateStore/State.ts";
import type { ResourceState } from "@/State";

/**
 * The S3 state store keeps the stack's state, generated secrets included, in
 * its object bodies. The AWS client logs every request payload and parsed
 * response at Debug, so a Debug floor in the context the store is built in
 * (the CLI's run log sets one) must not make the store log those bodies.
 */

const SECRET = "generated-secret-value-0123456789";

const ENVIRONMENT = {
  accountId: "123456789012",
  region: "us-east-1",
  credentials: Effect.succeed({
    accessKeyId: Redacted.make("AKIDEXAMPLE"),
    secretAccessKey: Redacted.make("example-secret-access-key"),
    sessionToken: undefined,
    region: "us-east-1",
  }),
  endpoint: "http://s3.test",
} as const;

/** Bucket configuration the store reconciles on first use, already converged. */
const BUCKET_CONFIG: Record<string, string> = {
  versioning: "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
  encryption:
    "<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault><BucketKeyEnabled>false</BucketKeyEnabled><BlockedEncryptionTypes><EncryptionType>NONE</EncryptionType></BlockedEncryptionTypes></Rule></ServerSideEncryptionConfiguration>",
  publicAccessBlock:
    "<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>",
  ownershipControls:
    "<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>",
};

/** An S3 endpoint that already has the bucket and accepts every object write. */
const fakeS3 = () =>
  HttpClient.make((request) => {
    const subresource = Object.keys(BUCKET_CONFIG).find((name) =>
      new URL(request.url).searchParams.has(name),
    );
    const body =
      request.method === "GET" && subresource !== undefined ? BUCKET_CONFIG[subresource]! : "";
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 })));
  });

const state = {
  status: "created",
  fqn: "state",
  logicalId: "Token",
  instanceId: "i-1",
  resourceType: "Test.Token",
  providerVersion: 0,
  props: {},
  attr: { token: SECRET },
  bindings: [],
  downstream: [],
} as unknown as ResourceState;

/** Runs `f` with the AWS services stubbed and returns every log record. */
const captureLogs = (floor: "Debug" | "Info", f: Effect.Effect<unknown, unknown, never>) =>
  Effect.gen(function* () {
    const records: string[] = [];
    const logger = Logger.make<unknown, void>((options) => {
      records.push(JSON.stringify(options.message, (_, v) => (typeof v === "bigint" ? `${v}` : v)));
    });
    yield* f.pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, floor),
    );
    return records.join("\n");
  });

const services = () =>
  Context.empty().pipe(
    Context.add(HttpClient.HttpClient, fakeS3()),
    Context.add(AWSEnvironment, Effect.succeed(ENVIRONMENT as never)),
    Context.add(Credentials, ENVIRONMENT.credentials as never),
  );

describe("S3 state store logging", { tags: ["unit", "local"] }, () => {
  it.effect("does not log state contents when the build context's floor is Debug", () =>
    Effect.gen(function* () {
      const logs = yield* captureLogs(
        "Debug",
        Effect.gen(function* () {
          const store = yield* makeS3State({ bucketName: "state-bucket" });
          yield* store.set({ stack: "app", stage: "dev", fqn: "state", value: state });
        }).pipe(Effect.provideContext(services()), Effect.orDie),
      );
      expect(logs).not.toContain(SECRET);
    }),
  );

  it.effect("control: the AWS client still logs payloads outside the state store at Debug", () =>
    Effect.gen(function* () {
      const logs = yield* captureLogs(
        "Debug",
        s3
          .putObject({ Bucket: "other-bucket", Key: "k", Body: SECRET })
          .pipe(Effect.provideContext(services()), Effect.orDie),
      );
      expect(logs).toContain(SECRET);
    }),
  );
});
