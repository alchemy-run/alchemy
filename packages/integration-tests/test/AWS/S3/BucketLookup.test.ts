import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";
import LookupBucketFunctionLive, {
  LookupBucketFunction,
  lookupBucketName,
} from "./fixtures/lookup-bucket-handler.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:s3", "live"];

// The target belongs to another stack, as a lookup's target always should.
// It is named from the stage so the fixture Function can look it up by a
// name it computes itself.
const TargetStack = Alchemy.Stack(
  "BucketLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("lookup-target", {
      bucketName: lookupBucketName(yield* Stage),
      forceDestroy: true,
    });
    return {
      bucketName: bucket.bucketName.as<string>(),
      bucketArn: bucket.bucketArn.as<string>(),
      region: bucket.region.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

// Fresh function URLs take a few seconds to start serving 200s.
const retrying = <A, E, R>(request: Effect.Effect<A, E, R>) =>
  request.pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential("1 second"), Schedule.recurs(8)]),
    }),
  );

const fetchText = (request: Effect.Effect<any, any, any>) =>
  retrying(
    request.pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.text
          : Effect.fail(new Error(`status ${response.status}`)),
      ),
    ),
  );

test.provider(
  "a Lambda binds a looked-up bucket, reads and writes its objects, and the bucket survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { bucketName } = yield* target;
      const program = Effect.gen(function* () {
        return yield* LookupBucketFunction;
      }).pipe(Effect.provide(LookupBucketFunctionLive));

      const { functionUrl, functionName } = yield* stack.deploy(program);
      const url = functionUrl!.replace(/\/+$/, "");
      const client = yield* HttpClient.HttpClient;

      expect(yield* fetchText(client.get(`${url}/bucket`))).toBe(bucketName);
      yield* fetchText(
        client.post(`${url}/put?key=lookup.txt`, { body: HttpBody.text("looked up") }),
      );
      expect(yield* fetchText(client.get(`${url}/get?key=lookup.txt`))).toBe("looked up");

      // The write landed in the looked-up bucket.
      const object = yield* s3.getObject({ Bucket: bucketName, Key: "lookup.txt" });
      expect(yield* Stream.mkString(Stream.decodeText(object.Body!))).toBe("looked up");

      // A lookup re-resolves to the same bucket, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources.LookupBucketFunction?.action).toBe("noop");

      // Destroying the stack that looked it up removes the Function and
      // leaves the bucket alone.
      yield* stack.destroy();
      const fn = yield* lambda
        .getFunction({ FunctionName: functionName })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
      expect(fn).toBeUndefined();
      yield* s3.getBucketLocation({ Bucket: bucketName });
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a looked-up bucket reports its ARN and region",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { bucketName, bucketArn, region } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const bucket = AWS.S3.Bucket.lookup({ bucketName });
          return { arn: bucket.bucketArn, region: bucket.region };
        },
        { arn: bucketArn, region },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing bucket fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucketName = missingName(stack.stage, "alchemy-missing");
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-bucket", {
            value: AWS.S3.Bucket.lookup({ bucketName }).bucketArn,
          }),
        ),
        ["LookupNotFoundError", bucketName],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a bucket this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.S3.Bucket("lookup-managed", { forceDestroy: true });
      const { bucketName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-bucket-consumer", {
              value: AWS.S3.Bucket.lookup({ bucketName }).bucketArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
