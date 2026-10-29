/**
 * The queued management transport: the deployer stores a request envelope
 * in the fleet bucket, enqueues its id, and waits for the runner's reply
 * object. The runner (an ECS task inside the fleet VPC) claims each request
 * with a conditional create before executing it, so a request runs at most
 * once even when SQS delivers it twice — and the deployer can cancel a
 * request no runner picked up by claiming it first.
 *
 * Request, claim and reply objects live under
 * `alchemy/management/v1/requests/{id}/`; the deployer deletes them once it
 * has the reply and a bucket lifecycle rule expires any left behind.
 */
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ecs from "@distilled.cloud/aws/ecs";
import { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { FleetConnection } from "../Host.ts";
import { FleetManagementError } from "../Management.ts";
import { MANAGEMENT_PREFIX, type ManagementQueueState } from "./EcsManagement.ts";
import { executeManagementRequest, type ManagementTransport } from "./ManagementRunner.ts";

const requestsPrefix = `${MANAGEMENT_PREFIX}/requests/`;
const requestKey = (id: string) => `${requestsPrefix}${id}/request.json`;
const claimKey = (id: string) => `${requestsPrefix}${id}/claim`;
const replyKey = (id: string) => `${requestsPrefix}${id}/reply.json`;
/** On-demand runners publish how long they stay up here. */
const heartbeatKey = `${MANAGEMENT_PREFIX}/runner.json`;

/** A runner the deployer may still reach must have at least this much time left. */
const HEARTBEAT_MARGIN_MS = 30_000;
/** How long a freshly started task may take to boot and claim a request. */
const CLAIM_DEADLINE_MS = 180_000;
/** How long a claimed request may run (the Lambda runner's own bound). */
const EXECUTION_DEADLINE_MS = 90_000;
const POLL_INTERVAL = "500 millis";

const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const bucketOf = (connection: FleetConnection) =>
  /^s3:\/\/([^/]+)$/.exec(connection.bucket?.uri ?? "")?.[1];

const ambiguous = (message: string) =>
  new FleetManagementError({
    reason: "transport",
    message: `${message}; mutation outcome may be ambiguous.`,
  });

const readBody = (body: Stream.Stream<Uint8Array, unknown> | undefined) =>
  body === undefined
    ? Effect.succeed(new Uint8Array())
    : Stream.runCollect(body).pipe(
        Effect.mapError(() => ambiguous("Queued Celld management object read was interrupted")),
        Effect.map((chunks) => {
          const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return bytes;
        }),
      );

const decodeJson = (bytes: Uint8Array) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    catch: () =>
      new FleetManagementError({
        reason: "transport",
        message: "Invalid queued Celld management object.",
      }),
  });

/** Read an object, or `undefined` when it does not exist. */
const getObject = (Bucket: string, Key: string) =>
  s3.getObject({ Bucket, Key }).pipe(
    Effect.map((object) => object.Body),
    Effect.catchTag("NoSuchKey", () => Effect.succeed(null)),
    Effect.flatMap((body) => (body === null ? Effect.undefined : readBody(body))),
  );

/**
 * Claim a request with a conditional create. Returns whether this caller
 * owns the claim: a lost response followed by a retried PUT still reports
 * ownership, because the stored token is compared.
 */
const claim = (Bucket: string, id: string, owner: string) =>
  s3
    .putObject({
      Bucket,
      Key: claimKey(id),
      Body: new TextEncoder().encode(owner),
      IfNoneMatch: "*",
    })
    .pipe(
      Effect.as(true),
      Effect.catchTag(["PreconditionFailed", "ConditionalRequestConflict"], () =>
        getObject(Bucket, claimKey(id)).pipe(
          Effect.map(
            (stored) => stored !== undefined && new TextDecoder().decode(stored) === owner,
          ),
        ),
      ),
    );

/** The deployer half: store, enqueue, and wait for the reply. */
export const makeQueueTransport = Effect.gen(function* () {
  const services = Layer.mergeAll(
    Layer.succeed(Credentials, yield* Credentials),
    Layer.succeed(HttpClient.HttpClient, yield* HttpClient.HttpClient),
    Layer.succeed(Region, yield* Region),
  );

  /** Start a runner unless one is up with enough time left to take this request. */
  const ensureRunner = Effect.fn(function* (Bucket: string, state: ManagementQueueState) {
    const launch = state.launch;
    if (launch === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const heartbeat = yield* getObject(Bucket, heartbeatKey);
    if (heartbeat !== undefined) {
      const { expiresAt } = (yield* decodeJson(heartbeat)) as { expiresAt?: unknown };
      if (typeof expiresAt === "number" && expiresAt - now > HEARTBEAT_MARGIN_MS) return;
    }
    // Mark the runner as starting first so concurrent requests from the
    // same deploy wait for this task instead of each starting their own.
    yield* s3.putObject({
      Bucket,
      Key: heartbeatKey,
      Body: new TextEncoder().encode(JSON.stringify({ expiresAt: now + CLAIM_DEADLINE_MS })),
    });
    const started = yield* ecs.runTask({
      cluster: launch.clusterArn,
      taskDefinition: launch.taskDefinitionArn,
      launchType: "FARGATE",
      count: 1,
      startedBy: "alchemy-celld",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: launch.subnetIds,
          securityGroups: launch.securityGroupIds,
          assignPublicIp: "ENABLED",
        },
      },
    });
    if ((started.tasks ?? []).length === 0)
      return yield* new FleetManagementError({
        reason: "configuration",
        message: `Could not start the Celld management task: ${
          started.failures?.map((failure) => failure.reason).join(", ") || "no task started"
        }.`,
      });
  });

  /** Poll for the reply; cancel the request if no runner claims it in time. */
  const awaitReply = Effect.fn(function* (Bucket: string, id: string, owner: string) {
    const startedAt = yield* Clock.currentTimeMillis;
    let claimedAt: number | undefined;
    for (;;) {
      const reply = yield* getObject(Bucket, replyKey(id));
      if (reply !== undefined) return reply;
      const now = yield* Clock.currentTimeMillis;
      if (claimedAt === undefined && now - startedAt > CLAIM_DEADLINE_MS) {
        if (yield* claim(Bucket, id, owner))
          return yield* new FleetManagementError({
            reason: "transport",
            message:
              "No Celld management runner picked up the request in time; nothing was executed.",
          });
        claimedAt = now;
      }
      if (claimedAt !== undefined && now - claimedAt > EXECUTION_DEADLINE_MS)
        return yield* ambiguous("Celld management request timed out");
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  const transport: ManagementTransport = (connection, payload) =>
    Effect.gen(function* () {
      const Bucket = bucketOf(connection);
      const state = connection.hostState?.managementQueue as ManagementQueueState | undefined;
      if (Bucket === undefined || typeof state?.queueUrl !== "string")
        return yield* new FleetManagementError({
          reason: "configuration",
          message: "Fleet hostState must include a managementQueue and backing bucket.",
        });
      const [id, owner] = yield* Effect.sync(() => [crypto.randomUUID(), crypto.randomUUID()]);
      yield* s3.putObject({
        Bucket,
        Key: requestKey(id),
        Body: payload,
        ContentType: "application/json",
        IfNoneMatch: "*",
      });
      yield* ensureRunner(Bucket, state);
      yield* sqs.sendMessage({
        QueueUrl: state.queueUrl,
        MessageBody: JSON.stringify({ version: 1, id }),
      });
      const reply = yield* awaitReply(Bucket, id, owner);
      yield* Effect.forEach([requestKey(id), claimKey(id), replyKey(id)], (Key) =>
        s3.deleteObject({ Bucket, Key }).pipe(Effect.ignore),
      );
      return reply;
    }).pipe(
      Effect.provide(services),
      Effect.mapError((error) =>
        error._tag === "Celld.FleetManagementError"
          ? error
          : ambiguous("Queued Celld management request failed"),
      ),
    );
  return transport;
});

/**
 * The runner half, run inside an ECS task: drain the queue, executing each
 * request it claims and storing the reply. With an idle window it publishes
 * a heartbeat and exits once it has had no work for that long; without one
 * it runs until stopped.
 */
const drainManagementQueue = Effect.gen(function* () {
  const queueUrl = yield* Config.String("CELLD_MANAGEMENT_QUEUE_URL");
  const Bucket = yield* Config.String("CELLD_MANAGEMENT_BUCKET");
  const idleMs =
    (yield* Config.Number("CELLD_MANAGEMENT_IDLE_SECONDS").pipe(Config.withDefault(0))) * 1000;
  const owner = yield* Effect.sync(() => crypto.randomUUID());
  let lastWork = yield* Clock.currentTimeMillis;

  const publishHeartbeat = (expiresAt: number) =>
    s3
      .putObject({
        Bucket,
        Key: heartbeatKey,
        Body: new TextEncoder().encode(JSON.stringify({ expiresAt })),
      })
      .pipe(Effect.ignore);

  const handle = Effect.fn(function* (body: string | undefined) {
    const id = yield* Effect.try({
      try: () => (JSON.parse(body ?? "") as { id?: unknown }).id,
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (typeof id !== "string" || !requestId.test(id)) return;
    if (!(yield* claim(Bucket, id, owner))) return;
    const request = yield* getObject(Bucket, requestKey(id));
    const response =
      request === undefined
        ? {
            ok: false as const,
            error: { reason: "configuration" as const, message: "Request object is missing." },
          }
        : yield* decodeJson(request).pipe(
            Effect.flatMap(executeManagementRequest),
            Effect.orElseSucceed(() => ({
              ok: false as const,
              error: {
                reason: "configuration" as const,
                message: "Invalid queued Celld management request.",
              },
            })),
          );
    yield* s3.putObject({
      Bucket,
      Key: replyKey(id),
      Body: new TextEncoder().encode(JSON.stringify(response)),
      ContentType: "application/json",
    });
  });

  for (;;) {
    const now = yield* Clock.currentTimeMillis;
    if (idleMs > 0) {
      if (now - lastWork >= idleMs) return;
      yield* publishHeartbeat(lastWork + idleMs);
    }
    const received = yield* sqs.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds:
        idleMs > 0 ? Math.max(1, Math.min(20, Math.floor((lastWork + idleMs - now) / 1000))) : 20,
    });
    for (const message of received.Messages ?? []) {
      // Delete first: a request is claimed, never redelivered for a retry.
      if (message.ReceiptHandle)
        yield* sqs
          .deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle })
          .pipe(Effect.ignore);
      yield* handle(message.Body).pipe(
        Effect.catch((error) => Effect.logWarning("Celld management request failed", error)),
      );
      lastWork = yield* Clock.currentTimeMillis;
    }
  }
});

/**
 * {@link drainManagementQueue} as the task's entry: a failure (bad
 * configuration, lost queue access) is logged and ends the task — ECS
 * replaces a service's task, and the deployer starts a new on-demand one.
 */
export const runManagementQueue = drainManagementQueue.pipe(
  Effect.catchCause((cause) => Effect.logError("Celld management runner stopped", cause)),
);
