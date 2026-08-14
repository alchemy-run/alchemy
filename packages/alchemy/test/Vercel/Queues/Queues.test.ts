/**
 * Vercel Queues data-plane foundation tests — live against the standing
 * Vercel test team (run with the doppler alchemy-v2/dev env).
 *
 * There is no `subscribe` event source yet (separate wave), so these tests
 * pin the data plane directly: a prebuilt Function carrying a
 * `queue/v2beta` trigger provides the project + deployment (and configures
 * the project's consumer registry — sends 503 without one), and the test
 * drives SendMessage/ReceiveMessages from outside Vercel via a minted
 * project OIDC token.
 *
 * Live-verified platform facts this suite leans on (PROBES.md probe 4):
 * - visibility is partitioned by `Vqs-Deployment-Id` — pinned and unpinned
 *   sends live in disjoint partitions;
 * - fresh consumer groups replay the topic from the beginning;
 * - messages expire on their own (retention) — there is no delete API;
 * - minted OIDC tokens are ALWAYS development-environment-scoped, and the
 *   queue namespace is per (project, environment) — so this whole suite
 *   operates in the dev namespace (self-consistent: every send and receive
 *   uses minted tokens). Deployed-function (production-scoped) queue
 *   behavior is covered by Subscribe.test.ts via in-scope readback.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** Must match the trigger topic in fixtures/queue-output/.vc-config.json. */
const TOPIC_NAME = "alchemy-queues-foundation";

const fixtureDir = new URL("./fixtures/queue-output", import.meta.url).pathname;

/**
 * The typed topic value — schema + region + send defaults in one place.
 * `retentionSeconds` keeps test messages short-lived (there is no delete
 * API; expiry is the cleanup).
 */
class Orders extends Vercel.Topic<Orders>()(TOPIC_NAME, {
  schema: Schema.Struct({
    orderId: Schema.String,
    amountCents: Schema.Int,
    runId: Schema.String,
  }),
  region: "iad1",
  retentionSeconds: 300,
}) {}

/** Poll (bounded) until the function's project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

test.provider(
  "data plane: schema round-trip, partitions, ack, replay, extendLease",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // ── Deploy a prebuilt function whose queue trigger configures the
      //    project's consumer registry.
      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Vercel.Function("QueueFn", { prebuilt: fixtureDir });
        }),
      );
      expect(fn.projectId).toBeDefined();
      expect(fn.deploymentId).toBeTruthy();

      // ── Region/name pinning comes from the Topic value.
      expect(Orders.region).toEqual("iad1");
      expect(Orders.topicName).toEqual(TOPIC_NAME);
      expect(Orders.partition).toEqual("deployment");

      // ── OIDC: minted from the management API (we are outside Vercel).
      const token = yield* Vercel.mintProjectOidcToken(fn.projectId);
      const runId = yield* Effect.sync(() => crypto.randomUUID());

      // ── Pinned send (the deployment partition — the load-bearing path).
      const producer = yield* Vercel.makeSendMessageClient(Orders, {
        token,
        deploymentId: fn.deploymentId,
      });
      const pinned1 = yield* producer.send({
        orderId: "pinned-1",
        amountCents: 4200,
        runId,
      });
      expect(pinned1.messageId).toBeTruthy();

      // ── Fresh consumer group A sees it; payload round-trips through
      //    Schema; Vqs metadata is surfaced.
      const consumerA = yield* Vercel.makeReceiveMessagesClient(Orders, {
        consumerGroup: "alchemy-test-a",
        token,
        deploymentId: fn.deploymentId,
      });
      const batchA = yield* consumerA
        .receive({ maxMessages: 10, visibilityTimeoutSeconds: 5 })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (batch) => batch.some((m) => m.payload.runId === runId),
            times: 15,
          }),
        );
      const msgA = batchA.find((m) => m.payload.runId === runId);
      expect(msgA).toBeDefined();
      expect(msgA!.payload).toEqual({
        orderId: "pinned-1",
        amountCents: 4200,
        runId,
      });
      expect(msgA!.messageId).toEqual(pinned1.messageId);
      expect(msgA!.receiptHandle).toBeTruthy();
      expect(msgA!.deliveryCount).toBeGreaterThanOrEqual(1);

      // ── Ack in group A: after the 5s visibility window has passed, the
      //    message is NOT redelivered to A.
      yield* consumerA.ack(msgA!.receiptHandle);
      yield* Effect.sleep("8 seconds");
      const redeliveredA = yield* consumerA.receive({
        maxMessages: 10,
        visibilityTimeoutSeconds: 5,
      });
      expect(
        redeliveredA.filter(
          (m) => m.payload.runId === runId && m.payload.orderId === "pinned-1",
        ),
      ).toHaveLength(0);

      // ── Fresh group B replays the topic even though A acked (per-group
      //    cursors — live-verified platform behavior).
      const consumerB = yield* Vercel.makeReceiveMessagesClient(Orders, {
        consumerGroup: "alchemy-test-b",
        token,
        deploymentId: fn.deploymentId,
      });
      const batchB = yield* consumerB
        .receive({ maxMessages: 10, visibilityTimeoutSeconds: 30 })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (batch) =>
              batch.some(
                (m) =>
                  m.payload.runId === runId && m.payload.orderId === "pinned-1",
              ),
            times: 15,
          }),
        );
      const msgB = batchB.find(
        (m) => m.payload.runId === runId && m.payload.orderId === "pinned-1",
      );
      expect(msgB).toBeDefined();
      yield* consumerB.ack(msgB!.receiptHandle);

      // ── extendLease actually extends: receive with a 6s lease, extend to
      //    60s, and after 10s the message is still leased (not redelivered).
      const pinned2 = yield* producer.send({
        orderId: "pinned-2",
        amountCents: 100,
        runId,
      });
      expect(pinned2.messageId).toBeTruthy();
      const consumerC = yield* Vercel.makeReceiveMessagesClient(Orders, {
        consumerGroup: "alchemy-test-lease",
        token,
        deploymentId: fn.deploymentId,
      });
      const batchC = yield* consumerC
        .receive({ maxMessages: 10, visibilityTimeoutSeconds: 6 })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (batch) =>
              batch.some(
                (m) =>
                  m.payload.runId === runId && m.payload.orderId === "pinned-2",
              ),
            times: 15,
          }),
        );
      const msgC = batchC.find(
        (m) => m.payload.runId === runId && m.payload.orderId === "pinned-2",
      )!;
      // Ack pinned-1 if this fresh group picked it up too, so the
      // still-leased assertion below can only be about pinned-2.
      for (const other of batchC) {
        if (other.messageId !== msgC.messageId) {
          yield* consumerC.ack(other.receiptHandle);
        }
      }
      yield* consumerC.extendLease(msgC.receiptHandle, 60);
      yield* Effect.sleep("10 seconds");
      const afterExtend = yield* consumerC.receive({ maxMessages: 10 });
      expect(
        afterExtend.filter(
          (m) => m.payload.runId === runId && m.payload.orderId === "pinned-2",
        ),
      ).toHaveLength(0);
      yield* consumerC.ack(msgC.receiptHandle);

      // ── Acking a completed delivery again fails with a typed tag.
      const doubleAck = yield* consumerC
        .ack(msgC.receiptHandle)
        .pipe(Effect.result);
      expect(Result.isFailure(doubleAck)).toBe(true);
      if (Result.isFailure(doubleAck)) {
        expect([
          "Vercel.Queues.MessageNotFound",
          "Vercel.Queues.MessageNotAvailable",
        ]).toContain(doubleAck.failure._tag);
      }

      // ── The unpinned (shared) partition is disjoint: an unpinned send is
      //    only visible to unpinned receivers.
      const sharedProducer = yield* Vercel.makeSendMessageClient(Orders, {
        token,
        deploymentId: null,
      });
      yield* sharedProducer.send({
        orderId: "unpinned-1",
        amountCents: 7,
        runId,
      });
      const consumerShared = yield* Vercel.makeReceiveMessagesClient(Orders, {
        consumerGroup: "alchemy-test-shared",
        token,
        deploymentId: null,
      });
      const batchShared = yield* consumerShared
        .receive({ maxMessages: 10, visibilityTimeoutSeconds: 30 })
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (batch) =>
              batch.some(
                (m) =>
                  m.payload.runId === runId &&
                  m.payload.orderId === "unpinned-1",
              ),
            times: 15,
          }),
        );
      const msgShared = batchShared.find(
        (m) => m.payload.runId === runId && m.payload.orderId === "unpinned-1",
      );
      expect(msgShared).toBeDefined();
      // Disjointness: the shared receiver never saw the pinned messages.
      expect(
        batchShared.filter(
          (m) =>
            m.payload.runId === runId && m.payload.orderId !== "unpinned-1",
        ),
      ).toHaveLength(0);
      yield* consumerShared.ack(msgShared!.receiptHandle);

      // ── Cleanup: the owned project cascades; messages expire on their own
      //    (≤300s retention set on the Topic).
      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
