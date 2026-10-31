import { fileURLToPath } from "node:url";
/**
 * `AWS.Lambda.Function` under `alchemy dev`: the dualized provider deploys
 * the function INTO the floci emulator (RPC-sidecar-hosted
 * `FlociFunctionProvider`) and hot-swaps its code on file change.
 *
 * Proof structure:
 *   - attrs carry the emulator shape — dummy-account ARN
 *     (`:000000000000:`) and a `*.lambda-url.us-east-1.localhost:4566`
 *     function URL — which the live cloud can never produce;
 *   - the function URL is host-reachable and serves the fixture's marker;
 *   - rewriting the fixture source (in a CLONE, the repo tree stays clean)
 *     is observed at the URL without another deploy — the sidecar watch
 *     loop rebuilds, uploads to the emulator's assets bucket, and floci's
 *     reactive S3 sync re-extracts (measured latency reported);
 *   - an engine-driven update (env change) between two rewrites does not
 *     detach the function from the watch loop's dev key — the next rewrite
 *     still serves (regression: the watcher memoized its one-time
 *     enrollment and never re-pointed the function after the live
 *     reconcile moved it to a content-addressed key);
 *   - a dualized Queue + a `bundle: false` Function + a distilled
 *     event-source mapping pump SQS messages through the containerized
 *     function into a dualized Bucket;
 *   - after destroy the function and its `/aws/lambda/<name>` log group
 *     are gone from the emulator.
 *
 * Requires Docker (floci + the Lambda runtime container); skipped when the
 * daemon is unavailable.
 */
import * as AWS from "@alchemy.run/aws";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Region from "@alchemy.run/aws/Region";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ApiGateway from "@distilled.cloud/aws/api-gateway";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Events from "@distilled.cloud/aws/eventbridge";
import * as Lambda from "@distilled.cloud/aws/lambda";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as SSM from "@distilled.cloud/aws/ssm";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import { createInternalTags, hasTags } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { liveContext } from "../Local/fixtures/live.ts";
import { FLOCI_ENDPOINT, rawS3GetObject } from "../Local/fixtures/raw.ts";
import RemoteBindingFunctionLive, {
  RemoteBindingFunction,
} from "./fixtures/floci-remote-binding/handler.ts";
import RemoteEventsFunctionLive, {
  RemoteEventsFunction,
} from "./fixtures/floci-remote-events/handler.ts";
import RemotePushFunctionLive, {
  RemotePushFunction,
} from "./fixtures/floci-remote-push/handler.ts";
import UnbridgedConnectFunctionLive, {
  UnbridgedConnectFunction,
} from "./fixtures/floci-unbridged/connect.ts";
import UnbridgedEventFunctionLive, {
  UnbridgedEventFunction,
} from "./fixtures/floci-unbridged/event.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const devFixtureDir = fileURLToPath(new URL("../Lambda/fixtures/floci-dev", import.meta.url));
const esmHandlerPath = fileURLToPath(
  new URL("../Lambda/fixtures/floci-esm/handler.mjs", import.meta.url),
);

/** Deploy for real from a dev test file: the run mode `alchemy deploy` uses. */
const asDeploy = Layer.effect(
  AlchemyContext,
  AlchemyContext.pipe(Effect.map((context) => ({ ...context, dev: false }))),
);

/** Floci-scoped context for the raw distilled calls the test makes itself. */
const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

test.provider(
  "dev deploys a Function into floci with a reachable URL and hot reload",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const client = yield* HttpClient.HttpClient;

      yield* stack.destroy();

      // Clone the fixture so the hot-reload rewrite never touches the repo
      // tree.
      const clone = yield* cloneFixture(devFixtureDir, {
        prefix: "floci-dev-fn-",
      });
      const mainPath = path.join(clone, "handler.ts");

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("DevFn", {
          main: mainPath,
          handler: "handler",
          isExternal: true,
          functionUrl: true,
          env: { DEV_MARKER: "env-carried" },
        }),
      );

      // Emulator-shaped identity: the live cloud can never produce these.
      expect(fn.functionArn).toContain(":000000000000:");
      expect(fn.functionArn).toContain(":us-east-1:");
      expect(fn.functionUrl).toBeDefined();
      expect(fn.functionUrl).toContain("localhost:4566");

      // First invoke pulls the Lambda runtime image (~4.4s cold), then warm.
      const first = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("2 seconds"),
          times: 60,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean => res.status === 200 && res.body.startsWith("marker-v1"),
          times: 60,
        }),
      );
      expect(first.status).toBe(200);
      expect(first.body).toBe("marker-v1:env-carried");

      // Hot reload: rewrite the CLONED source and wait (bounded) for the
      // new marker to serve — no deploy in between. The sidecar watch loop
      // rebuilds + uploads; floci's reactive S3 sync re-extracts.
      const source = yield* fs.readFileString(mainPath);
      const swapStartedAt = Date.now();
      yield* fs.writeFileString(mainPath, source.replace(`"marker-v1"`, `"marker-v2"`));

      const swapped = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean => res.status === 200 && res.body.startsWith("marker-v2"),
          times: 240,
        }),
      );
      const swapLatencyMs = Date.now() - swapStartedAt;
      expect(swapped.body).toBe("marker-v2:env-carried");
      yield* Effect.log(`hot reload observed at the function URL in ${swapLatencyMs}ms`);

      // Second swap: the function's code is now enrolled on the stable dev
      // S3 key, so this one is a bare PutObject + floci reactive re-extract
      // (no Lambda API call).
      const secondStartedAt = Date.now();
      yield* fs.writeFileString(mainPath, source.replace(`"marker-v1"`, `"marker-v3"`));
      const reswapped = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean => res.status === 200 && res.body.startsWith("marker-v3"),
          times: 240,
        }),
      );
      const secondSwapLatencyMs = Date.now() - secondStartedAt;
      expect(reswapped.body).toBe("marker-v3:env-carried");
      yield* Effect.log(
        `second hot reload (reactive S3 sync) observed in ${secondSwapLatencyMs}ms`,
      );

      // Engine-driven UPDATE between swaps (a prop change — here `env`):
      // the live reconcile re-uploads the bundle to a content-addressed key
      // and re-points the function THERE, detaching it from the watch
      // loop's stable dev key. The watcher must notice and re-enroll on its
      // next swap; before the fix the marker below never served (the
      // PutObject landed on a key the function no longer read) until the
      // next engine update happened to re-bundle it.
      const updated = yield* stack.deploy(
        AWS.Lambda.Function("DevFn", {
          main: mainPath,
          handler: "handler",
          isExternal: true,
          functionUrl: true,
          env: { DEV_MARKER: "env-updated" },
        }),
      );
      expect(updated.functionUrl).toBe(fn.functionUrl);
      const afterUpdate = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean => res.status === 200 && res.body === "marker-v3:env-updated",
          times: 240,
        }),
      );
      expect(afterUpdate.body).toBe("marker-v3:env-updated");

      yield* fs.writeFileString(mainPath, source.replace(`"marker-v1"`, `"marker-v4"`));
      const afterUpdateSwap = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean => res.status === 200 && res.body.startsWith("marker-v4"),
          times: 240,
        }),
      );
      expect(afterUpdateSwap.body).toBe("marker-v4:env-updated");

      // The invocations above made the emulator create the function's log
      // group (control: the destroy assertion below is not vacuous).
      const logGroupName = `/aws/lambda/${fn.functionName}`;
      const logGroupExists = Logs.describeLogGroups({
        logGroupNamePrefix: logGroupName,
      }).pipe(
        Effect.map((r) => (r.logGroups ?? []).some((g) => g.logGroupName === logGroupName)),
        Effect.provide(flociContext),
      );
      const existedBeforeDestroy = yield* logGroupExists.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (exists): boolean => exists,
          times: 20,
        }),
      );
      expect(existedBeforeDestroy).toBe(true);

      // Destroy: the function (and its role) must be gone from the
      // emulator.
      yield* stack.destroy();
      expect(yield* logGroupExists).toBe(false);
      const gone = yield* Lambda.getFunction({
        FunctionName: fn.functionName,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        Effect.provide(flociContext),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (isGone): boolean => isGone,
          times: 20,
        }),
      );
      expect(gone).toBe(true);
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "local"], timeout: 540_000 },
);

test.provider(
  "SQS -> dev Function (bundle: false) -> S3 event pumping in the emulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const markerKey = "floci-dev-esm-consumed.txt";

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("DevEsmQueue");
          const bucket = yield* AWS.S3.Bucket("DevEsmTarget", {
            forceDestroy: true,
          });
          const fn = yield* AWS.Lambda.Function("DevEsmFn", {
            main: esmHandlerPath,
            handler: "handler",
            bundle: false,
            functionUrl: false,
            env: { TARGET_BUCKET: bucket.bucketName },
          });
          // The dualized RESOURCE (requires the alchemy floci fork ≥
          // 1.6.0-alchemy.2: its reconciler's ownership scan calls lambda
          // ListTags on the `event-source-mapping:` ARN, and creation
          // brands it with Tags).
          const esm = yield* AWS.Lambda.EventSourceMapping("DevEsm", {
            functionName: fn.functionName,
            eventSourceArn: queue.queueArn,
            batchSize: 1,
            enabled: true,
          });
          return { queue, bucket, fn, esm };
        }),
      );
      expect(outputs.queue.queueArn).toContain(":000000000000:");
      expect(outputs.fn.functionArn).toContain(":000000000000:");
      expect(outputs.esm.eventSourceMappingArn).toContain(":000000000000:");

      yield* SQS.sendMessage({
        QueueUrl: outputs.queue.queueUrl,
        MessageBody: markerKey,
      }).pipe(Effect.provide(flociContext));

      // Bounded poll: floci's ESM poller delivers to the containerized
      // function, whose S3 write-back proves consumption.
      const consumed = yield* rawS3GetObject(outputs.bucket.bucketName, markerKey).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (res): boolean => res.status === 200,
          times: 40,
        }),
      );
      expect(consumed.status).toBe(200);

      // Destroy tears down the mapping (stopping its poller), the
      // function, the queue, and the bucket in dependency order.
      yield* stack.destroy();

      const esmGone = yield* Lambda.getEventSourceMapping({
        UUID: outputs.esm.uuid,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        Effect.provide(flociContext),
      );
      expect(esmGone).toBe(true);

      const gone = yield* Lambda.getFunction({
        FunctionName: outputs.fn.functionName,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
        Effect.provide(flociContext),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (isGone): boolean => isGone,
          times: 20,
        }),
      );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "provider:aws:sqs", "local"],
    timeout: 540_000,
  },
);

test.provider(
  "logging.retention creates the log group with its policy before the first invoke",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (logging?: AWS.Lambda.FunctionProps["logging"]) =>
        stack.deploy(
          AWS.Lambda.Function("DevRetentionFn", {
            main: esmHandlerPath,
            handler: "handler",
            bundle: false,
            functionUrl: false,
            logging,
          }),
        );

      // Alchemy always owns the function's log group (the execution role
      // cannot create it), so it exists before any invoke — with no
      // retention until `logging` sets one.
      const fn = yield* deploy();
      const logGroupName = `/aws/lambda/${fn.functionName}`;
      const findGroup = Logs.describeLogGroups({ logGroupNamePrefix: logGroupName }).pipe(
        Effect.map((page) => page.logGroups?.find((g) => g.logGroupName === logGroupName)),
        Effect.provide(flociContext),
      );
      yield* Effect.addFinalizer(() =>
        Logs.deleteLogGroup({ logGroupName }).pipe(Effect.provide(flociContext), Effect.ignore),
      );
      const initial = yield* findGroup;
      expect(initial).toBeDefined();
      expect(initial?.retentionInDays).toBeUndefined();

      // 10 days rounds up to CloudWatch's 14.
      yield* deploy({ retention: "10 days" });
      expect((yield* findGroup)?.retentionInDays).toBe(14);

      // "forever" clears the policy and keeps the group.
      yield* deploy({ retention: "forever" });
      const cleared = yield* findGroup;
      expect(cleared).toBeDefined();
      expect(cleared?.retentionInDays).toBeUndefined();

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "local"], timeout: 300_000 },
);

test.provider(
  "a dev Function's bindings reach Alchemy.remote() resources in the real cloud",
  (stack) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RemoteBindingFunction;
        }).pipe(Effect.provide(RemoteBindingFunctionLive)),
      );
      // The function itself is emulated.
      expect(fn.functionUrl).toContain("localhost:4566");

      const fetchText = (path: string) =>
        client.get(`${fn.functionUrl!.replace(/\/$/, "")}${path}`).pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (body) => ({ status: response.status, body })),
          ),
          Effect.retry({
            while: (): boolean => true,
            schedule: Schedule.spaced("2 seconds"),
            times: 60,
          }),
        );

      // First invoke pulls the Lambda runtime image; wait for the function to serve.
      const info = yield* fetchText("/info").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean => res.status === 200,
          times: 60,
        }),
      );
      const { bucketName, queueUrl } = JSON.parse(info.body) as {
        bucketName: string;
        queueUrl: string;
      };

      // A freshly-minted live key takes a few seconds to propagate.
      const put = yield* fetchText("/put?key=hello.txt&value=from-floci").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean => res.status === 200,
          times: 30,
        }),
      );
      expect(put.body).toBe("ok");
      const get = yield* fetchText("/get?key=hello.txt");
      expect(get).toEqual({ status: 200, body: "from-floci" });

      // Out-of-band: the object landed in the REAL bucket.
      const object = yield* S3.getObject({ Bucket: bucketName, Key: "hello.txt" }).pipe(
        Effect.flatMap((result) => Stream.mkString(Stream.decodeText(result.Body!))),
        Effect.provide(liveContext),
      );
      expect(object).toBe("from-floci");

      // A binding that resolves its credentials when the layer is built
      // (before any resource is bound) reaches the real queue too.
      const sent = yield* fetchText("/send?value=from-floci");
      expect(sent).toEqual({ status: 200, body: "ok" });
      const received = yield* SQS.receiveMessage({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 5,
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (result): boolean => (result.Messages ?? []).length > 0,
          times: 10,
        }),
        Effect.provide(liveContext),
      );
      expect(received.Messages?.[0]?.Body).toBe("from-floci");

      // The developer's credentials reach the Lambda through the emulator.
      const { name, stage } = yield* Stack;
      const relayed = yield* SSM.getParameter({
        Name: `/alchemy/${name}/${stage}/dev-credentials`,
        WithDecryption: true,
      }).pipe(Effect.provide(flociContext));
      expect(relayed.Parameter?.Value).toBeDefined();

      yield* stack.destroy();

      const gone = yield* S3.headBucket({ Bucket: bucketName }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.provide(liveContext),
      );
      expect(gone).toBe(true);
      // SQS reports a deleted queue for up to a minute.
      const queueGone = yield* SQS.getQueueAttributes({ QueueUrl: queueUrl }).pipe(
        Effect.map(() => false),
        Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (gone) => gone, times: 14 }),
        Effect.provide(liveContext),
      );
      expect(queueGone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "provider:aws:sqs", "local"],
    timeout: 540_000,
  },
);

test.provider(
  "a dev Function consumes event sources in the real cloud",
  (stack) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RemoteEventsFunction;
        }).pipe(Effect.provide(RemoteEventsFunctionLive)),
      );
      expect(fn.functionUrl).toContain("localhost:4566");

      const info = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({ status: response.status, body })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("2 seconds"),
          times: 60,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean => res.status === 200,
          times: 60,
        }),
      );
      const { bucketName, queueUrl } = JSON.parse(info.body) as {
        bucketName: string;
        queueUrl: string;
      };

      // Real events, produced out of band in the real cloud.
      yield* SQS.sendMessage({ QueueUrl: queueUrl, MessageBody: "from-the-cloud" }).pipe(
        Effect.provide(liveContext),
      );
      yield* S3.putObject({ Bucket: bucketName, Key: "uploads/hello.txt", Body: "hi" }).pipe(
        Effect.provide(liveContext),
      );

      // The local Lambda handled both and wrote the results to the real bucket.
      const read = (key: string) =>
        S3.getObject({ Bucket: bucketName, Key: key }).pipe(
          Effect.retry({
            while: (error) => error._tag === "NoSuchKey",
            schedule: Schedule.spaced("3 seconds"),
            times: 30,
          }),
          Effect.flatMap((result) => Stream.mkString(Stream.decodeText(result.Body!))),
          Effect.provide(liveContext),
        );
      expect(yield* read("received/from-the-cloud")).toBe("from-the-cloud");
      expect(yield* read("seen/hello.txt")).toBe("uploads/hello.txt");
      // The real stub Lambda the events went through: the one sharing the
      // emulated Function's bridge queue.
      const local = yield* Lambda.getFunctionConfiguration({
        FunctionName: fn.functionName,
      }).pipe(Effect.provide(flociContext));
      // Env values come back Redacted.
      const bridgeQueueOf = (config: Lambda.FunctionConfiguration) => {
        const value = config.Environment?.Variables?.ALCHEMY_DEV_BRIDGE_QUEUE_URL;
        return Redacted.isRedacted(value) ? Redacted.value(value) : value;
      };
      const bridgeQueue = bridgeQueueOf(local);
      expect(bridgeQueue).toBeDefined();
      const stubs = Lambda.listFunctions.items({}).pipe(
        Stream.filter((config) => bridgeQueueOf(config) === bridgeQueue),
        Stream.map((config) => config.FunctionName),
        Stream.runCollect,
        Effect.provide(liveContext),
      );
      expect(yield* stubs).toHaveLength(1);

      // Promote: the same stack deployed for real. The Function now runs in
      // the cloud, so the stub, its queue and its bucket are collected, and
      // the real Function consumes the queue itself.
      const promoted = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* RemoteEventsFunction;
          }).pipe(Effect.provide(RemoteEventsFunctionLive)),
        )
        .pipe(Effect.provide(asDeploy));
      expect(promoted.functionArn).not.toContain(":000000000000:");
      expect(yield* stubs).toHaveLength(0);
      const bridgeQueueGone = yield* SQS.getQueueAttributes({ QueueUrl: bridgeQueue! }).pipe(
        Effect.map(() => false),
        Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (gone) => gone, times: 14 }),
        Effect.provide(liveContext),
      );
      expect(bridgeQueueGone).toBe(true);
      yield* SQS.sendMessage({ QueueUrl: queueUrl, MessageBody: "after-promotion" }).pipe(
        Effect.provide(liveContext),
      );
      expect(yield* read("received/after-promotion")).toBe("after-promotion");

      yield* stack.destroy();

      expect(yield* stubs).toHaveLength(0);

      const bucketGone = yield* S3.headBucket({ Bucket: bucketName }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.provide(liveContext),
      );
      expect(bucketGone).toBe(true);
      // SQS reports a deleted queue for up to a minute.
      const queueGone = yield* SQS.getQueueAttributes({ QueueUrl: queueUrl }).pipe(
        Effect.map(() => false),
        Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (gone) => gone, times: 14 }),
        Effect.provide(liveContext),
      );
      expect(queueGone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:s3", "provider:aws:sqs", "local"],
    timeout: 540_000,
  },
);

test.provider(
  "dev rejects the edges no bridge carries, by name, before creating anything",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const edgeOf = (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit)
          ? exit.cause.reasons.flatMap((reason) =>
              reason._tag === "Die" ? [reason.defect as { _tag?: string }] : [],
            )
          : [];

      // A deployed Function cannot receive an emulated queue's events.
      const event = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* UnbridgedEventFunction;
          }).pipe(Effect.provide(UnbridgedEventFunctionLive), Alchemy.remote()),
        )
        .pipe(Effect.exit);
      expect(edgeOf(event)).toContainEqual(
        expect.objectContaining({
          _tag: "UnbridgedDevEdge",
          from: "UnbridgedEventFunction",
          to: "UnbridgedQueue",
        }),
      );

      // This machine cannot reach a cache that only has a private endpoint.
      const connect = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* UnbridgedConnectFunction;
          }).pipe(Effect.provide(UnbridgedConnectFunctionLive)),
        )
        .pipe(Effect.exit);
      expect(edgeOf(connect)).toContainEqual(
        expect.objectContaining({ _tag: "UnbridgedDevEdge", edge: "connect" }),
      );

      // Only Lambda targets are bridged: a real bus cannot deliver to an
      // emulated queue.
      const route = yield* stack
        .deploy(
          Effect.gen(function* () {
            const bus = yield* AWS.EventBridge.EventBus("UnbridgedBus", {}).pipe(Alchemy.remote());
            const queue = yield* AWS.SQS.Queue("UnbridgedTargetQueue");
            yield* AWS.EventBridge.events(bus, { source: ["alchemy.test"] }).toQueue(queue);
          }),
        )
        .pipe(Effect.exit);
      expect(edgeOf(route)).toContainEqual(
        expect.objectContaining({
          _tag: "UnbridgedDevEdge",
          from: "UnbridgedTargetQueue",
          to: "UnbridgedBus",
          edge: "event",
        }),
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:lambda", "local"], timeout: 120_000 },
);

test.provider(
  "real-cloud push sources reach a dev Function and get its responses back",
  (stack) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* stack.destroy();
      const { region } = yield* AWSEnvironment.current.pipe(Effect.provide(liveContext));

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RemotePushFunction;
        }).pipe(Effect.provide(RemotePushFunctionLive)),
      );
      expect(fn.functionUrl).toContain("localhost:4566");
      const info = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({ status: response.status, body })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("2 seconds"),
          times: 60,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean => res.status === 200,
          times: 60,
        }),
      );
      const { bucketName, busName } = JSON.parse(info.body) as {
        bucketName: string;
        busName: string;
      };

      // The real API, found by its tags.
      const tags = yield* createInternalTags("RemotePushApi");
      const findApis = ApiGateway.getRestApis.items({}).pipe(
        Stream.filter((api) => api.id !== undefined && hasTags(tags, api.tags)),
        Stream.map((api) => api.id!),
        Stream.runCollect,
        Effect.provide(liveContext),
      );
      const [apiId] = yield* findApis;
      expect(apiId).toBeDefined();
      const invokeUrl = `https://${apiId}.execute-api.${region}.amazonaws.com/test`;
      const get = (path: string, until: (status: number) => boolean) =>
        client.get(`${invokeUrl}${path}`).pipe(
          Effect.flatMap((response) =>
            Effect.map(response.text, (body) => ({
              status: response.status,
              served: response.headers["x-served-by"],
              body,
            })),
          ),
          Effect.retry({
            while: (): boolean => true,
            schedule: Schedule.spaced("2 seconds"),
            times: 30,
          }),
          // A fresh stage answers 403/404 for a few seconds.
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (res): boolean => until(res.status),
            times: 30,
          }),
        );

      // The local handler's response, status and headers come back through the stub.
      const hello = yield* get("/hello?name=sam", (status) => status === 201);
      expect(hello.status).toBe(201);
      expect(hello.served).toBe("floci");
      expect(JSON.parse(hello.body)).toEqual({ path: "/hello", name: "sam" });

      // A failing local handler fails the real invocation.
      const boom = yield* get("/boom", (status) => status === 502);
      expect(boom.status).toBe(502);

      // A custom bus in the real cloud delivers to the local handler.
      yield* Events.putEvents({
        Entries: [
          {
            EventBusName: busName,
            Source: "alchemy.test",
            DetailType: "Ping",
            Detail: JSON.stringify({ id: "evt-1" }),
          },
        ],
      }).pipe(Effect.provide(liveContext));
      const recorded = yield* S3.getObject({ Bucket: bucketName, Key: "bus/evt-1" }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NoSuchKey",
          schedule: Schedule.spaced("3 seconds"),
          times: 30,
        }),
        Effect.flatMap((result) => Stream.mkString(Stream.decodeText(result.Body!))),
        Effect.provide(liveContext),
      );
      expect(recorded).toBe("Ping");

      yield* stack.destroy();

      expect(yield* findApis).toEqual([]);
      const bucketGone = yield* S3.headBucket({ Bucket: bucketName }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.provide(liveContext),
      );
      expect(bucketGone).toBe(true);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:aws:apigateway",
      "provider:aws:eventbridge",
      "local",
    ],
    timeout: 540_000,
  },
);
