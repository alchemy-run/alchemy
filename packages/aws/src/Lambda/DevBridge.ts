import { fileURLToPath } from "node:url";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { isEmulated } from "alchemy/Provider";
import { remote, UnbridgedDevEdge } from "alchemy/ProviderMode";
import type { ResourceLike } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { DEV_BRIDGE_ENV } from "../Local/DevBridgeEnv.ts";
import { Bucket } from "../S3/Bucket.ts";
import { Queue } from "../SQS/Queue.ts";
import { Function } from "./Function.ts";

/**
 * Where an event source's events come from: a resource, the AWS platform
 * itself (`"aws"`, e.g. service events on the default EventBridge bus), or
 * nowhere in particular (`undefined`: the source follows the run mode).
 */
export type EventOrigin = ResourceLike | "aws" | undefined;

/**
 * Wire an event source to a Lambda host: `wire` declares the triggers
 * (mapping, permission, subscription, ...) against the Function it is given,
 * normally the host itself.
 *
 * In `alchemy dev`, an emulated host whose events come from the real cloud
 * cannot be the target: the real service can only invoke a real Lambda. The
 * triggers then target a stub Function deployed in the real cloud, which
 * forwards every invocation to the emulated host (see `Lambda/dev-stub`).
 * A deployed host whose events come from an emulated resource is rejected.
 */
export const wireEventSource = <A, E, R>(
  host: Function,
  origin: EventOrigin,
  wire: (target: Function) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const hostEmulated = yield* isEmulated(host);
    const originEmulated =
      origin === undefined ? hostEmulated : origin === "aws" ? false : yield* isEmulated(origin);
    if (hostEmulated === originEmulated) return yield* wire(host);
    if (!hostEmulated) {
      const resource = typeof origin === "object" ? origin.FQN : String(origin);
      return yield* Effect.die(
        new UnbridgedDevEdge({
          message:
            `${host.FQN} is deployed, but its event source ${resource} is emulated by ` +
            "`alchemy dev`, which a deployed Function cannot receive events from. " +
            "Pipe the event source through Alchemy.remote() too, or emulate the Function.",
          from: host.FQN,
          to: resource,
          edge: "event",
        }),
      );
    }
    // Under the host, so the triggers of two hosts' stubs never collide.
    const stub = yield* devStub(host);
    return yield* Namespace.push(host.LogicalId, wire(stub)).pipe(remote());
  });

/**
 * The real-cloud stand-in for an emulated Function, and the queue and
 * bucket it forwards invocations through. Declared under the host, once
 * per host: every event source of the host shares them.
 */
const devStub = (host: Function) =>
  Namespace.push(
    host.LogicalId,
    Effect.gen(function* () {
      // Invocations wait in the queue only while the stub does.
      const queue = yield* Queue("DevBridgeQueue", {
        messageRetentionPeriod: "15 minutes",
        visibilityTimeout: "15 minutes",
      });
      const bucket = yield* Bucket("DevBridgeBucket", { forceDestroy: true });
      const main = yield* Effect.sync(() =>
        fileURLToPath(new URL("./dev-stub/index.mjs", import.meta.url)),
      );
      const stub = yield* Function("DevStub", {
        main,
        bundle: false,
        handler: "handler",
        functionUrl: false,
        // Event sources check it, e.g. SQS against the queue's visibility timeout.
        timeout: host.Props.timeout,
        env: {
          [DEV_BRIDGE_ENV.queueUrl]: queue.queueUrl,
          [DEV_BRIDGE_ENV.bucket]: bucket.bucketName,
        },
      });
      yield* stub.bind`AWS.Lambda.DevBridge(${stub})`({
        policyStatements: [
          { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: [queue.queueArn] },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
          // Without it, a response not written yet reads as AccessDenied.
          { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [bucket.bucketArn] },
        ],
      });
      const runtime = yield* CurrentRuntimeContext;
      if (runtime !== undefined) {
        yield* runtime.set(DEV_BRIDGE_ENV.queueUrl, queue.queueUrl);
        yield* runtime.set(DEV_BRIDGE_ENV.bucket, bucket.bucketName);
      }
      return stub;
    }),
  ).pipe(remote());
