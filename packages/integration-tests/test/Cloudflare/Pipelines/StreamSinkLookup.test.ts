import crypto from "node:crypto";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as user from "@distilled.cloud/cloudflare/user";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:pipelines",
  "provider:cloudflare:r2",
  "live",
];

// R2 S3-compatible credentials are derived from the active API token: the
// access key id is the token id and the secret is the SHA-256 hex digest of
// the token value.
const r2Credentials = Effect.gen(function* () {
  const creds = yield* yield* CloudflareEnvironment;
  if (creds.type !== "apiToken") {
    return yield* Effect.die(
      new Error("Pipelines lookup tests require an apiToken profile for R2 sink credentials"),
    );
  }
  const token = Redacted.value(creds.apiToken);
  const verified = token.startsWith("cfat_")
    ? yield* accounts.verifyToken({ accountId: creds.accountId })
    : yield* user.verifyToken({});
  const secretAccessKey = yield* Effect.sync(() =>
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    accessKeyId: Redacted.make(verified.id),
    secretAccessKey: Redacted.make(secretAccessKey),
  };
});

// The stream and sink belong to another stack, as a lookup's target always
// should.
const TargetStack = Alchemy.Stack(
  "PipelinesLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("lookup-sink-bucket", { forceDestroy: true });
    const stream = yield* Cloudflare.Pipelines.Stream("lookup-stream", {});
    const sink = yield* Cloudflare.Pipelines.Sink("lookup-sink", {
      type: "r2",
      config: {
        bucket: bucket.bucketName,
        // A stack body may only fail with ConfigError; a credential failure
        // here is a broken test profile.
        credentials: yield* Effect.orDie(r2Credentials),
        rollingPolicy: { intervalSeconds: 10 },
      },
    });
    return {
      streamName: stream.name.as<string>(),
      streamId: stream.streamId.as<string>(),
      sinkName: sink.name.as<string>(),
      sinkId: sink.sinkId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack), { timeout: 300_000 });

test.provider(
  "a pipeline reads a looked-up stream into a looked-up sink, and both survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { streamName, streamId, sinkName, sinkId } = yield* target;

      const program = Effect.gen(function* () {
        const stream = Cloudflare.Pipelines.Stream.lookup({ name: streamName });
        const sink = Cloudflare.Pipelines.Sink.lookup({ sinkId });
        const byId = Cloudflare.Pipelines.Stream.lookup({ streamId });
        const pipeline = yield* Cloudflare.Pipelines.Pipeline("lookup-etl", {
          sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${byId.name}`,
        });
        return {
          sql: pipeline.sql,
          pipelineId: pipeline.pipelineId,
          streamId: stream.streamId,
          sinkName: sink.name,
        };
      });
      const out = yield* stack.deploy(program);
      expect(out.streamId).toBe(streamId);
      expect(out.sinkName).toBe(sinkName);
      expect(out.sql).toBe(`INSERT INTO ${sinkName} SELECT * FROM ${streamName}`);

      // A lookup re-resolves to the same stream and sink, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["lookup-etl"].action).toBe("noop");

      // Destroy removes the pipeline and leaves the stream and sink alone.
      yield* stack.destroy();
      expect((yield* pipelines.getStream({ accountId, streamId })).name).toBe(streamName);
      expect((yield* pipelines.getSink({ accountId, sinkId })).name).toBe(sinkName);
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a missing stream fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { sinkName } = yield* target;
      const name = missingName(stack.stage).replaceAll("-", "_");
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Pipelines.Pipeline("lookup-missing-etl", {
            sql: Output.interpolate`INSERT INTO ${sinkName} SELECT * FROM ${
              Cloudflare.Pipelines.Stream.lookup({ name }).name
            }`,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a stream this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { sinkName } = yield* target;
      const managed = () => Cloudflare.Pipelines.Stream("lookup-managed", {});
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Pipelines.Pipeline("lookup-managed-etl", {
              sql: Output.interpolate`INSERT INTO ${sinkName} SELECT * FROM ${
                Cloudflare.Pipelines.Stream.lookup({ name }).name
              }`,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
