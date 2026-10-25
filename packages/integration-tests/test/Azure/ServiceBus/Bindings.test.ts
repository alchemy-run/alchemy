import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import ServiceBusFunction, {
  BatchQueue,
  Bus,
  CompleteQueue,
  CompleteSub,
  PeekLockQueue,
  PeekLockSub,
  QueueSendQueue,
  ReadQueue,
  ReadSub,
  ReadWriteQueue,
  ReceiveDeleteQueue,
  ReceiveDeleteSub,
  RenewQueue,
  RenewSub,
  SendQueue,
  SendTopic,
  SendTopicSub,
  UnlockQueue,
  UnlockSub,
  WriteQueue,
  WriteTopic,
  WriteTopicSub,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureServiceBusBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* ServiceBusFunction;
    const bus = yield* Bus;
    // The deployer sends and receives out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    const R = Azure.Authorization.BuiltInRole;
    for (const [id, roleDefinitionId] of [
      ["SbDeployerSender", R.ServiceBusDataSender],
      ["SbDeployerReceiver", R.ServiceBusDataReceiver],
    ] as const) {
      yield* Azure.Authorization.RoleAssignment(id, {
        scope: bus.namespaceId,
        roleDefinitionId,
        principalId: deployer,
        principalType: "ServicePrincipal",
      });
    }
    const queues = {
      send: yield* SendQueue,
      batch: yield* BatchQueue,
      peekLock: yield* PeekLockQueue,
      receiveDelete: yield* ReceiveDeleteQueue,
      complete: yield* CompleteQueue,
      unlock: yield* UnlockQueue,
      renew: yield* RenewQueue,
      read: yield* ReadQueue,
      write: yield* WriteQueue,
      readWrite: yield* ReadWriteQueue,
      queueSend: yield* QueueSendQueue,
    };
    const subscriptions = {
      send: yield* SendTopicSub,
      write: yield* WriteTopicSub,
      peekLock: yield* PeekLockSub,
      receiveDelete: yield* ReceiveDeleteSub,
      complete: yield* CompleteSub,
      unlock: yield* UnlockSub,
      renew: yield* RenewSub,
      read: yield* ReadSub,
    };
    const sendTopic = yield* SendTopic;
    const writeTopic = yield* WriteTopic;
    return {
      url: fn.url,
      principalId: fn.principalId,
      namespaceName: bus.namespaceName,
      resourceGroup: bus.resourceGroup,
      queueNames: Object.fromEntries(
        Object.entries(queues).map(([key, queue]) => [key, queue.queueName]),
      ),
      queueIds: Object.fromEntries(
        Object.entries(queues).map(([key, queue]) => [key, queue.queueId]),
      ),
      subscriptions: Object.fromEntries(
        Object.entries(subscriptions).map(([key, sub]) => [
          key,
          { topicName: sub.topicName, subscriptionName: sub.subscriptionName },
        ]),
      ),
      subscriptionIds: Object.fromEntries(
        Object.entries(subscriptions).map(([key, sub]) => [key, sub.subscriptionResourceId]),
      ),
      topicIds: { send: sendTopic.topicId, write: writeTopic.topicId },
    };
  }),
);

type QueueKey =
  | "send"
  | "batch"
  | "peekLock"
  | "receiveDelete"
  | "complete"
  | "unlock"
  | "renew"
  | "read"
  | "write"
  | "readWrite"
  | "queueSend";
type SubKey =
  | "send"
  | "write"
  | "peekLock"
  | "receiveDelete"
  | "complete"
  | "unlock"
  | "renew"
  | "read";

// ~$0.01/run (Service Bus Standard namespace for ~15 min, a Flex Consumption app); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/** One call of a binding route. Fails with the body unless it answered `ok`. */
const callOnce = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    );
  });

/** Retry for the Flex Consumption cold start and role propagation (~6 min). */
const propagation = { schedule: Schedule.spaced("5 seconds"), times: 72 } as const;

/**
 * Call a binding route until it answers `ok`, then return the last answer
 * so a real failure shows its Azure error.
 */
const call = (route: string) =>
  callOnce(route).pipe(
    Effect.retry(propagation),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Retry an out-of-band call while the deployer's own data roles propagate. */
const asDeployer = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "MessagingUnauthorized",
      schedule: Schedule.spaced("5 seconds"),
      times: 72,
    }),
  );

const text = (body: Uint8Array | undefined) =>
  body === undefined ? undefined : new TextDecoder().decode(body);

/**
 * Out-of-band access to a queue with the deployer's credentials. Empties
 * the queue first, so a rerun never sees an earlier run's messages.
 */
const oobQueue = (key: QueueKey) =>
  Effect.gen(function* () {
    const { namespaceName, queueNames } = yield* stack;
    const queueName = queueNames[key]!;
    const take = (timeout: number) =>
      asDeployer(messaging.ReceiveAndDeleteMessage({ namespaceName, queueName, timeout }));
    yield* take(1).pipe(Effect.repeat({ until: (m) => m.body === undefined, times: 20 }));
    return {
      send: (body: string) =>
        asDeployer(
          messaging.SendMessage({
            namespaceName,
            entityPath: queueName,
            body,
            contentType: "text/plain",
          }),
        ),
      /** Receive and delete the next message, waiting up to `timeout` seconds. */
      take,
      peekLock: () =>
        asDeployer(messaging.PeekLockMessage({ namespaceName, queueName, timeout: 10 })),
      complete: (messageId: string, lockToken: string) =>
        asDeployer(messaging.CompleteMessage({ namespaceName, queueName, messageId, lockToken })),
      unlock: (messageId: string, lockToken: string) =>
        asDeployer(messaging.UnlockMessage({ namespaceName, queueName, messageId, lockToken })),
    };
  });

/** Out-of-band access to a topic subscription; empties it first. */
const oobSub = (key: SubKey) =>
  Effect.gen(function* () {
    const { namespaceName, subscriptions } = yield* stack;
    const { topicName, subscriptionName } = subscriptions[key]!;
    const target = { namespaceName, topicName, subscriptionName };
    const take = (timeout: number) =>
      asDeployer(messaging.ReceiveAndDeleteSubscriptionMessage({ ...target, timeout }));
    yield* take(1).pipe(Effect.repeat({ until: (m) => m.body === undefined, times: 20 }));
    return {
      send: (body: string) =>
        asDeployer(
          messaging.SendMessage({
            namespaceName,
            entityPath: topicName,
            body,
            contentType: "text/plain",
          }),
        ),
      take,
      peekLock: () => asDeployer(messaging.PeekLockSubscriptionMessage({ ...target, timeout: 10 })),
      complete: (messageId: string, lockToken: string) =>
        asDeployer(messaging.CompleteSubscriptionMessage({ ...target, messageId, lockToken })),
      unlock: (messageId: string, lockToken: string) =>
        asDeployer(messaging.UnlockSubscriptionMessage({ ...target, messageId, lockToken })),
    };
  });

/** `.../messages/{reference}/{lockToken}` → the reference and the token. */
const lockOf = (location: string | undefined) => {
  const segments = location === undefined ? [] : new URL(location).pathname.split("/");
  return { ref: segments.at(-2) ?? "", lock: segments.at(-1) ?? "" };
};

/** The out-of-band calls {@link settleThrough} needs, for a queue or a subscription. */
interface Lockable {
  peekLock: () => Effect.Effect<{ body?: Uint8Array; location?: string }, unknown>;
  unlock: (ref: string, lock: string) => Effect.Effect<unknown, unknown>;
}

/**
 * Lock a message out of band and settle it through `route`. Retried as a
 * pair: a failed call releases the lock first, so the next try can lock the
 * message again.
 */
const settleThrough = (oob: Lockable, route: string) =>
  Effect.gen(function* () {
    const locked = yield* oob.peekLock();
    if (locked.body === undefined) {
      return yield* Effect.fail<Body>({ ok: false, error: "no message to lock" });
    }
    const { ref, lock } = lockOf(locked.location);
    return yield* callOnce(`${route}?ref=${ref}&lock=${encodeURIComponent(lock)}`).pipe(
      Effect.tapError(() => oob.unlock(ref, lock).pipe(Effect.ignore)),
    );
  }).pipe(
    Effect.retry(propagation),
    Effect.catch((error) =>
      Effect.succeed(
        (typeof error === "object" && error !== null && "ok" in error
          ? error
          : { ok: false, error: String(error) }) as Body,
      ),
    ),
  );

describe(
  "Azure Service Bus bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:servicebus", "live"] },
  () => {
    describe("SendMessage", () => {
      test(
        "sends a message with broker and custom properties to a queue",
        Effect.gen(function* () {
          const queue = yield* oobQueue("send");
          const body = yield* call("/send?id=send-1");
          expectOk(body);
          const received = yield* queue.take(10);
          expect({
            text: text(received.body),
            contentType: received.contentType,
            messageId: received.brokerProperties?.messageId,
            label: received.brokerProperties?.label,
            priority: received.headers?.priority,
          }).toEqual({
            text: JSON.stringify({ id: "send-1" }),
            contentType: "application/json",
            messageId: "send-1",
            label: "send",
            priority: '"high"',
          });
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );

      test(
        "publishes to a topic",
        Effect.gen(function* () {
          const sub = yield* oobSub("send");
          const body = yield* call("/send?to=topic&id=topic-1");
          expectOk(body);
          const received = yield* sub.take(10);
          expect(text(received.body)).toEqual(JSON.stringify({ id: "topic-1" }));
          expect(received.brokerProperties?.messageId).toEqual("topic-1");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SendMessageBatch", () => {
      test(
        "sends every message of a batch in order",
        Effect.gen(function* () {
          const queue = yield* oobQueue("batch");
          const body = yield* call("/send-batch?id=batch");
          expectOk(body);
          const first = yield* queue.take(10);
          const second = yield* queue.take(10);
          expect([
            [text(first.body), first.brokerProperties?.label],
            [text(second.body), second.headers?.position],
          ]).toEqual([
            ["batch-1", "first"],
            ["batch-2", '"second"'],
          ]);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("PeekLockMessage", () => {
      test(
        "locks the next message without removing it",
        Effect.gen(function* () {
          const queue = yield* oobQueue("peekLock");
          yield* queue.send("peek-1");
          const body = yield* call("/peek-lock");
          expectOk(body);
          expect(body.result.text).toEqual("peek-1");
          // Locked for the queue's 5-minute lock duration: nothing to receive.
          const during = yield* queue.take(2);
          expect(during.body).toBeUndefined();
          // The lock the Function took settles the message.
          const { ref, lock } = lockOf(body.result.location);
          yield* queue.complete(ref, lock);
          const after = yield* queue.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("ReceiveAndDeleteMessage", () => {
      test(
        "receives and removes the next message",
        Effect.gen(function* () {
          const queue = yield* oobQueue("receiveDelete");
          yield* queue.send("receive-1");
          const body = yield* call("/receive-delete");
          expectOk(body);
          expect(body.result.text).toEqual("receive-1");
          const after = yield* queue.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("CompleteMessage", () => {
      test(
        "deletes a message locked out of band",
        Effect.gen(function* () {
          const queue = yield* oobQueue("complete");
          yield* queue.send("complete-1");
          const body = yield* settleThrough(queue, "/complete");
          expectOk(body);
          const after = yield* queue.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("UnlockMessage", () => {
      test(
        "releases a lock so the message is delivered again",
        Effect.gen(function* () {
          const queue = yield* oobQueue("unlock");
          yield* queue.send("unlock-1");
          const body = yield* settleThrough(queue, "/unlock");
          expectOk(body);
          // Visible again at once, despite the 5-minute lock duration.
          const again = yield* queue.take(5);
          expect(text(again.body)).toEqual("unlock-1");
          expect(again.brokerProperties?.deliveryCount).toBeGreaterThan(1);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("RenewMessageLock", () => {
      test(
        "keeps a message locked past its 5-second lock duration",
        Effect.gen(function* () {
          const queue = yield* oobQueue("renew");
          yield* queue.send("renew-1");
          // The route completes 6 s after locking: only a renewed lock allows it.
          const body = yield* call("/renew");
          expectOk(body);
          expect(body.result.text).toEqual("renew-1");
          const after = yield* queue.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("PeekLockSubscriptionMessage", () => {
      test(
        "locks the next message of a subscription",
        Effect.gen(function* () {
          const sub = yield* oobSub("peekLock");
          yield* sub.send("sub-peek-1");
          const body = yield* call("/sub/peek-lock");
          expectOk(body);
          expect(body.result.text).toEqual("sub-peek-1");
          const during = yield* sub.take(2);
          expect(during.body).toBeUndefined();
          const { ref, lock } = lockOf(body.result.location);
          yield* sub.complete(ref, lock);
          const after = yield* sub.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("ReceiveAndDeleteSubscriptionMessage", () => {
      test(
        "receives and removes the next message of a subscription",
        Effect.gen(function* () {
          const sub = yield* oobSub("receiveDelete");
          yield* sub.send("sub-receive-1");
          const body = yield* call("/sub/receive-delete");
          expectOk(body);
          expect(body.result.text).toEqual("sub-receive-1");
          const after = yield* sub.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("CompleteSubscriptionMessage", () => {
      test(
        "deletes a subscription message locked out of band",
        Effect.gen(function* () {
          const sub = yield* oobSub("complete");
          yield* sub.send("sub-complete-1");
          const body = yield* settleThrough(sub, "/sub/complete");
          expectOk(body);
          const after = yield* sub.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("UnlockSubscriptionMessage", () => {
      test(
        "releases a subscription message's lock",
        Effect.gen(function* () {
          const sub = yield* oobSub("unlock");
          yield* sub.send("sub-unlock-1");
          const body = yield* settleThrough(sub, "/sub/unlock");
          expectOk(body);
          const again = yield* sub.take(5);
          expect(text(again.body)).toEqual("sub-unlock-1");
          expect(again.brokerProperties?.deliveryCount).toBeGreaterThan(1);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("RenewSubscriptionMessageLock", () => {
      test(
        "keeps a subscription message locked past its lock duration",
        Effect.gen(function* () {
          const sub = yield* oobSub("renew");
          yield* sub.send("sub-renew-1");
          const body = yield* call("/sub/renew");
          expectOk(body);
          expect(body.result.text).toEqual("sub-renew-1");
          const after = yield* sub.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("QueueRead", () => {
      test(
        "receives, abandons, renews, completes, and receive-and-deletes",
        Effect.gen(function* () {
          const queue = yield* oobQueue("read");
          yield* queue.send("read-1");
          yield* queue.send("read-2");
          const body = yield* call("/queue-read");
          expectOk(body);
          expect(body.result).toEqual({
            first: ["read-1", 1],
            again: ["read-1", 2],
            last: "read-2",
          });
          const after = yield* queue.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("QueueWrite", () => {
      test(
        "sends one message and a batch",
        Effect.gen(function* () {
          const queue = yield* oobQueue("write");
          const body = yield* call("/queue-write?id=write");
          expectOk(body);
          const single = yield* queue.take(10);
          const a = yield* queue.take(10);
          const b = yield* queue.take(10);
          expect([
            [text(single.body), single.contentType, single.brokerProperties?.messageId],
            [text(a.body), a.brokerProperties?.label],
            [text(b.body), b.contentType, b.brokerProperties?.timeToLive],
          ]).toEqual([
            [JSON.stringify({ id: "write" }), "application/json", "write"],
            ["write-a", "a"],
            [JSON.stringify({ id: "write-b" }), "application/json", 600],
          ]);
          expect(single.headers?.kind).toEqual('"single"');
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("QueueReadWrite", () => {
      test(
        "sends, receives, and completes a message",
        Effect.gen(function* () {
          const queue = yield* oobQueue("readWrite");
          const body = yield* call("/queue-read-write?id=read-write-1");
          expectOk(body);
          expect(body.result.text).toEqual("read-write-1");
          const after = yield* queue.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("QueueSend", () => {
      test(
        "sends a JSON message",
        Effect.gen(function* () {
          const queue = yield* oobQueue("queueSend");
          const body = yield* call("/queue-send?id=queue-send-1");
          expectOk(body);
          const received = yield* queue.take(10);
          expect([text(received.body), received.brokerProperties?.label]).toEqual([
            JSON.stringify({ id: "queue-send-1" }),
            "queue-send",
          ]);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("TopicWrite", () => {
      test(
        "publishes one message and a batch",
        Effect.gen(function* () {
          const sub = yield* oobSub("write");
          const body = yield* call("/topic-write?id=topic-write");
          expectOk(body);
          const texts: Array<string | undefined> = [];
          for (let i = 0; i < 3; i++) texts.push(text((yield* sub.take(10)).body));
          expect(texts).toEqual(["topic-write", "topic-write-a", "topic-write-b"]);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SubscriptionRead", () => {
      test(
        "receives and completes a subscription message",
        Effect.gen(function* () {
          const sub = yield* oobSub("read");
          yield* sub.send("sub-read-1");
          const body = yield* call("/subscription-read");
          expectOk(body);
          expect(body.result).toEqual({ text: "sub-read-1", deliveryCount: 1 });
          const after = yield* sub.take(2);
          expect(after.body).toBeUndefined();
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "assigns one data role per binding, scoped to the bound entity",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const R = Azure.Authorization.BuiltInRole;
          const id = (value: string | undefined) => value!.toLowerCase();
          const q = outputs.queueIds as Record<QueueKey, string>;
          const s = outputs.subscriptionIds as Record<SubKey, string>;
          const expected = [
            `${R.ServiceBusDataSender} ${id(q.send)}`,
            `${R.ServiceBusDataSender} ${id(outputs.topicIds.send)}`,
            `${R.ServiceBusDataSender} ${id(q.batch)}`,
            `${R.ServiceBusDataReceiver} ${id(q.peekLock)}`,
            `${R.ServiceBusDataReceiver} ${id(q.receiveDelete)}`,
            `${R.ServiceBusDataReceiver} ${id(q.complete)}`,
            `${R.ServiceBusDataReceiver} ${id(q.unlock)}`,
            `${R.ServiceBusDataReceiver} ${id(q.renew)}`,
            `${R.ServiceBusDataReceiver} ${id(s.peekLock)}`,
            `${R.ServiceBusDataReceiver} ${id(s.receiveDelete)}`,
            `${R.ServiceBusDataReceiver} ${id(s.complete)}`,
            `${R.ServiceBusDataReceiver} ${id(s.unlock)}`,
            `${R.ServiceBusDataReceiver} ${id(s.renew)}`,
            `${R.ServiceBusDataReceiver} ${id(q.read)}`,
            `${R.ServiceBusDataSender} ${id(q.write)}`,
            `${R.ServiceBusDataSender} ${id(q.readWrite)}`,
            `${R.ServiceBusDataReceiver} ${id(q.readWrite)}`,
            `${R.ServiceBusDataSender} ${id(q.queueSend)}`,
            `${R.ServiceBusDataSender} ${id(outputs.topicIds.write)}`,
            `${R.ServiceBusDataReceiver} ${id(s.read)}`,
          ].sort();
          // The role-assignment list trails new assignments by a few seconds.
          const assignments = yield* assignmentsOf(outputs.principalId!).pipe(
            // Drop the app's own host-storage grants (scoped to its account).
            Effect.map((all) => all.filter((a) => !/\/storageaccounts\/[^/]+$/.test(a)).sort()),
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (found) => found.length >= expected.length,
              times: 12,
            }),
          );
          expect(assignments).toEqual(expected);
        }).pipe(Effect.provide(azure)),
        { timeout: 180_000 },
      );
    });
  },
);

const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    return page.value.map(
      (a) =>
        `${a.properties?.roleDefinitionId?.split("/").pop()} ${a.properties?.scope?.toLowerCase()}`,
    );
  });

// Destroy, then prove the Function's role assignments and the namespace (with
// every queue, topic, and subscription in it) are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, resourceGroup, namespaceName } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    // Azure drops the assignments with their scopes, after the asynchronous
    // resource-group delete finishes (measured: 1-4 min).
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 36,
      }),
    );
    expect(remaining).toEqual([]);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const status = yield* servicebus
      .GetNamespace({ subscriptionId, resourceGroupName: resourceGroup, namespaceName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (s) => s === "gone",
          times: 24,
        }),
      );
    expect(status).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
