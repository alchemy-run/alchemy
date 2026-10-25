import * as Azure from "@alchemy.run/azure";
import { collectAll } from "@alchemy.run/azure/Arm";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as eventgridNamespace from "@distilled.cloud/azure/eventgrid-namespace";
import * as storage from "@distilled.cloud/azure/storage";
import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import EventGridBindingsFunction, {
  CloudEventTopic,
  CustomTopic,
  EventGridTopic,
  Namespace,
  Orders,
  Workers,
} from "./fixtures/function.ts";

const {
  test: baseTest,
  beforeAll,
  afterAll,
  deploy,
  destroy,
} = Test.make({
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

/** Storage queue a topic delivers into, read out of band with an account SAS. */
const Sink = Azure.Storage.StorageAccount("EgBindingsSink");
const sinkQueue = (id: string) =>
  Effect.gen(function* () {
    const account = yield* Sink;
    return yield* Azure.Storage.Queue(id, { storageAccount: account.storageAccountName });
  });

/** Deliver every event of `topic` into `queueName` of the sink account. */
const toQueue = (
  id: string,
  topic: Azure.EventGrid.Topic,
  account: Azure.Storage.StorageAccount,
  queue: Azure.Storage.Queue,
  eventDeliverySchema?: "EventGridSchema" | "CloudEventSchemaV1_0",
) =>
  Azure.EventGrid.TopicEventSubscription(id, {
    topic: topic.topicName,
    destination: {
      endpointType: "StorageQueue",
      resourceId: account.storageAccountId,
      queueName: queue.queueName,
    },
    retryPolicy: { maxDeliveryAttempts: 5, eventTimeToLiveInMinutes: 30 },
    eventDeliverySchema,
  });

const Stack = Alchemy.Stack(
  "AzureEventGridBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* EventGridBindingsFunction;
    const account = yield* Sink;
    const eventGridQueue = yield* sinkQueue("EgBindingsEventGridQueue");
    const cloudEventQueue = yield* sinkQueue("EgBindingsCloudEventQueue");
    const customQueue = yield* sinkQueue("EgBindingsCustomQueue");
    const eventGridTopic = yield* EventGridTopic;
    const cloudEventTopic = yield* CloudEventTopic;
    const customTopic = yield* CustomTopic;
    yield* toQueue("EgBindingsEventGridToQueue", eventGridTopic, account, eventGridQueue);
    yield* toQueue(
      "EgBindingsCloudEventToQueue",
      cloudEventTopic,
      account,
      cloudEventQueue,
      "CloudEventSchemaV1_0",
    );
    // Delivered in the Event Grid schema, so the input mapping shows.
    yield* toQueue("EgBindingsCustomToQueue", customTopic, account, customQueue, "EventGridSchema");

    const namespace = yield* Namespace;
    const orders = yield* Orders;
    const workers = yield* Workers;
    /** Out-of-band view of what the Function publishes (`Order.Created` only). */
    const audit = yield* Azure.EventGrid.NamespaceTopicEventSubscription("EgBindingsAudit", {
      namespace: namespace.namespaceName,
      topic: orders.namespaceTopicName,
      queue: { receiveLockDurationInSeconds: 60 },
      includedEventTypes: ["Order.Created"],
    });

    // The deployer publishes and receives out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("EgBindingsDeployerSend", {
      scope: orders.namespaceTopicId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.EventGridDataSender,
      principalId: deployer,
    });
    const receiveRole = yield* Azure.Authorization.RoleDefinition("EgBindingsDeployerReceiveRole", {
      description: "Event Grid bindings test: receive out of band",
      permissions: [{ dataActions: ["Microsoft.EventGrid/events/receive/action"] }],
    });
    yield* Azure.Authorization.RoleAssignment("EgBindingsDeployerReceiveWorkers", {
      scope: workers.eventSubscriptionId,
      roleDefinitionId: receiveRole.roleDefinitionId,
      principalId: deployer,
    });
    yield* Azure.Authorization.RoleAssignment("EgBindingsDeployerReceiveAudit", {
      scope: audit.eventSubscriptionId,
      roleDefinitionId: receiveRole.roleDefinitionId,
      principalId: deployer,
    });

    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: account.resourceGroup,
      accountName: account.storageAccountName,
      queues: {
        eventGrid: eventGridQueue.queueName,
        cloudEvent: cloudEventQueue.queueName,
        custom: customQueue.queueName,
      },
      topicIds: {
        eventGrid: eventGridTopic.topicId,
        cloudEvent: cloudEventTopic.topicId,
        custom: customTopic.topicId,
      },
      endpoint: Output.interpolate`https://${orders.topicsHostname}`,
      topicName: orders.namespaceTopicName,
      namespaceTopicId: orders.namespaceTopicId,
      workers: workers.eventSubscriptionName,
      workersId: workers.eventSubscriptionId,
      audit: audit.eventSubscriptionName,
    };
  }),
);

// Three free custom topics, a 1-TU Standard namespace (~$0.03/h), a
// Standard_LRS account, and a Flex Consumption app: well under $0.10/run;
// ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

/** Azure credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** A test whose body also gets the deployer's Azure credentials for out-of-band checks. */
const test = <A, E>(name: string, body: Effect.Effect<A, E, any>) =>
  baseTest(name, body.pipe(Effect.provide(azure)), { timeout: 600_000 });

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its Event Grid error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const uniqueId = (prefix: string) => Effect.sync(() => `${prefix}-${crypto.randomUUID()}`);

type SinkQueue = "eventGrid" | "cloudEvent" | "custom";

/** Queue endpoint signed with an account SAS the deployer lists through ARM. */
const sasEndpoint = Effect.gen(function* () {
  const { accountName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const { accountSasToken } = yield* storage.ListStorageAccountAccountSAS({
    subscriptionId,
    resourceGroupName: resourceGroup,
    accountName,
    signedServices: "q",
    signedResourceTypes: "sco",
    signedPermission: "rwdlacup",
    signedProtocol: "https",
    signedExpiry: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return `https://${accountName}.queue.core.windows.net/?${accountSasToken}`;
});

/** Event Grid writes each event as one queue message (JSON, or base64 JSON). */
const decode = (text: string) => {
  if (text.trimStart().startsWith("{")) return text;
  return Buffer.from(text, "base64").toString("utf8");
};

/** The delivered event with `id`, read out of band from a sink queue. */
const delivered = (key: SinkQueue, id: string) =>
  Effect.gen(function* () {
    const { queues: names } = yield* stack;
    const url = yield* sasEndpoint;
    const queueName = names[key];
    return yield* queues.MessagesDequeue({ url, queueName, numofmessages: 32 }).pipe(
      Effect.map((messages) =>
        messages
          .map((m) => JSON.parse(decode(m.MessageText)) as Record<string, unknown>)
          .find((event) => event.id === id),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (event) => event !== undefined,
        times: 24,
      }),
    );
  });

/** The deployer's roles on the namespace can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => e._tag === "Unauthorized" || e._tag === "Forbidden",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const workers = Effect.map(stack, ({ endpoint, topicName, workers }) => ({
  endpoint,
  topicName,
  eventSubscriptionName: workers,
}));

/** Publish a `Work.Item` CloudEvent out of band. */
const publishWork = (id: string) =>
  Effect.gen(function* () {
    const { endpoint, topicName } = yield* stack;
    yield* eventgridNamespace
      .PublishCloudEvent({
        endpoint,
        topicName,
        id,
        source: "/alchemy/eventgrid-bindings-test",
        type: "Work.Item",
        specversion: "1.0",
        data: { id },
      })
      .pipe(Effect.retry(whileDenied));
  });

/**
 * Receive the events with `ids` out of band from `subscription` (in that
 * order), acknowledging every other event so leftovers never block a later
 * test. Events not received within the budget are `undefined`.
 */
const receiveManyOob = (subscription: "workers" | "audit", ids: readonly string[]) =>
  Effect.gen(function* () {
    const outputs = yield* stack;
    const where = {
      endpoint: outputs.endpoint,
      topicName: outputs.topicName,
      eventSubscriptionName: outputs[subscription],
    };
    const found = new Map<string, eventgridNamespace.ReceiveDetails>();
    yield* eventgridNamespace.ReceiveCloudEvents({ ...where, maxEvents: 10, maxWaitTime: 10 }).pipe(
      Effect.retry(whileDenied),
      Effect.flatMap((received) =>
        Effect.gen(function* () {
          const others: string[] = [];
          for (const r of received.value) {
            if (ids.includes(r.event.id)) found.set(r.event.id, r);
            else others.push(r.brokerProperties.lockToken);
          }
          if (others.length > 0) {
            yield* eventgridNamespace.AcknowledgeCloudEvents({ ...where, lockTokens: others });
          }
          return found.size;
        }),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (size) => size === ids.length,
        times: 12,
      }),
    );
    return ids.map((id) => found.get(id));
  });

/** Receive the event with `id` out of band (see {@link receiveManyOob}). */
const receiveOob = (subscription: "workers" | "audit", id: string) =>
  Effect.map(receiveManyOob(subscription, [id]), ([match]) => match);

/** Acknowledge lock tokens on the workers subscription out of band. */
const acknowledgeOob = (lockTokens: string[]) =>
  Effect.gen(function* () {
    const where = yield* workers;
    return yield* eventgridNamespace.AcknowledgeCloudEvents({ ...where, lockTokens });
  });

describe(
  "Event Grid data-plane bindings on an Azure Function",
  { tags: ["provider:azure", "live"], sequential: true },
  () => {
    describe("EventGrid.PublishEventGridEvents", () => {
      test(
        "publishes an Event Grid-schema event to a custom topic",
        Effect.gen(function* () {
          const id = yield* uniqueId("eg");
          const body = yield* call(`/publish-eventgrid?id=${id}`);
          expectOk(body);
          const event = yield* delivered("eventGrid", id);
          expect(event).toMatchObject({
            id,
            subject: `orders/${id}`,
            eventType: "Order.Created",
            data: { id },
          });
        }),
      );
    });

    describe("EventGrid.PublishCloudEventEvents", () => {
      test(
        "publishes a CloudEvent to a CloudEvents custom topic",
        Effect.gen(function* () {
          const id = yield* uniqueId("ce");
          const body = yield* call(`/publish-cloudevent-events?id=${id}`);
          expectOk(body);
          const event = yield* delivered("cloudEvent", id);
          expect(event).toMatchObject({ id, type: "Order.Created", data: { id } });
        }),
      );
    });

    describe("EventGrid.PublishCustomEventEvents", () => {
      test(
        "publishes a custom-schema event to a custom topic",
        Effect.gen(function* () {
          const id = yield* uniqueId("custom");
          const body = yield* call(`/publish-custom?id=${id}`);
          expectOk(body);
          const event = yield* delivered("custom", id);
          expect(event).toMatchObject({
            id,
            eventType: "Order.Custom",
            subject: "orders",
            dataVersion: "1.0",
            data: { orderId: id, kind: "Order.Custom" },
          });
        }),
      );
    });

    describe("EventGrid.PublishCloudEvent", () => {
      test(
        "publishes one CloudEvent to a namespace topic",
        Effect.gen(function* () {
          const id = yield* uniqueId("one");
          const body = yield* call(`/publish-cloud-event?id=${id}`);
          expectOk(body);
          const received = yield* receiveOob("audit", id);
          expect(received?.event).toMatchObject({ id, type: "Order.Created", data: { id } });
        }),
      );
    });

    describe("EventGrid.PublishCloudEvents", () => {
      test(
        "publishes a batch of CloudEvents to a namespace topic",
        Effect.gen(function* () {
          const id = yield* uniqueId("batch");
          const body = yield* call(`/publish-cloud-events?id=${id}`);
          expectOk(body);
          const [first, second] = yield* receiveManyOob("audit", [`${id}-a`, `${id}-b`]);
          expect([first?.event.id, second?.event.id]).toEqual([`${id}-a`, `${id}-b`]);
        }),
      );
    });

    describe("EventGrid.ReceiveCloudEvents", () => {
      test(
        "receives and locks an event from a pull subscription",
        Effect.gen(function* () {
          const id = yield* uniqueId("receive");
          yield* publishWork(id);
          const body = yield* call(`/receive?id=${id}`);
          expectOk(body);
          expect(body.result).toMatchObject({ id, type: "Work.Item", deliveryCount: 1 });
          // The Function's lock token settles the event out of band.
          const acked = yield* acknowledgeOob([body.result.lockToken]);
          expect(acked.succeededLockTokens).toEqual([body.result.lockToken]);
        }),
      );
    });

    describe("EventGrid.AcknowledgeCloudEvents", () => {
      test(
        "acknowledges a received event",
        Effect.gen(function* () {
          const id = yield* uniqueId("ack");
          yield* publishWork(id);
          const received = yield* receiveOob("workers", id);
          expect(received?.event.id).toEqual(id);
          const lockToken = received!.brokerProperties.lockToken;
          const body = yield* call(`/acknowledge?token=${encodeURIComponent(lockToken)}`);
          expectOk(body);
          expect(body.result.succeededLockTokens).toEqual([lockToken]);
          // Already settled: the same token no longer acknowledges.
          const again = yield* acknowledgeOob([lockToken]);
          expect(again.succeededLockTokens).toEqual([]);
          expect(again.failedLockTokens.map((f) => f.lockToken)).toEqual([lockToken]);
        }),
      );
    });

    describe("EventGrid.ReleaseCloudEvents", () => {
      test(
        "releases a received event for redelivery",
        Effect.gen(function* () {
          const id = yield* uniqueId("release");
          yield* publishWork(id);
          const received = yield* receiveOob("workers", id);
          expect(received?.event.id).toEqual(id);
          const lockToken = received!.brokerProperties.lockToken;
          const body = yield* call(`/release?token=${encodeURIComponent(lockToken)}`);
          expectOk(body);
          expect(body.result.succeededLockTokens).toEqual([lockToken]);
          const redelivered = yield* receiveOob("workers", id);
          expect(redelivered?.brokerProperties.deliveryCount).toEqual(2);
          yield* acknowledgeOob([redelivered!.brokerProperties.lockToken]);
        }),
      );
    });

    describe("EventGrid.RejectCloudEvents", () => {
      test(
        "rejects a received event",
        Effect.gen(function* () {
          const id = yield* uniqueId("reject");
          yield* publishWork(id);
          const received = yield* receiveOob("workers", id);
          expect(received?.event.id).toEqual(id);
          const lockToken = received!.brokerProperties.lockToken;
          const body = yield* call(`/reject?token=${encodeURIComponent(lockToken)}`);
          expectOk(body);
          expect(body.result.succeededLockTokens).toEqual([lockToken]);
          // Rejected: the token no longer settles the event.
          const again = yield* acknowledgeOob([lockToken]);
          expect(again.failedLockTokens.map((f) => f.lockToken)).toEqual([lockToken]);
        }),
      );
    });

    describe("EventGrid.RenewCloudEventLocks", () => {
      test(
        "renews the lock of a received event",
        Effect.gen(function* () {
          const id = yield* uniqueId("renew");
          yield* publishWork(id);
          const received = yield* receiveOob("workers", id);
          expect(received?.event.id).toEqual(id);
          const lockToken = received!.brokerProperties.lockToken;
          const body = yield* call(`/renew?token=${encodeURIComponent(lockToken)}`);
          expectOk(body);
          expect(body.result.succeededLockTokens).toEqual([lockToken]);
          // Still locked by that token: it settles the event.
          const acked = yield* acknowledgeOob([lockToken]);
          expect(acked.succeededLockTokens).toEqual([lockToken]);
        }),
      );
    });

    describe("least privilege", () => {
      test(
        "grants only EventGrid Data Sender on topics and receive on the subscription",
        Effect.gen(function* () {
          const outputs = yield* stack;
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          // The role-assignment list can trail the assignments by a minute.
          const assignments = yield* collectAll(authorization.ListRoleAssignmentForSubscription, {
            subscriptionId,
            _filter: `principalId eq '${outputs.principalId}'`,
          }).pipe(
            Effect.map((page) =>
              page.value.filter(
                (a) =>
                  // Drop the app's own host-storage grants.
                  !(a.properties?.scope?.toLowerCase() ?? "").endsWith(
                    `/storageaccounts/${outputs.hostStorageAccount}`,
                  ),
              ),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (list) => list.length >= 5,
              times: 12,
            }),
          );
          const grants: string[] = [];
          for (const assignment of assignments) {
            const scope = assignment.properties?.scope?.toLowerCase() ?? "";
            const roleDefinitionId =
              assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
            const role = yield* authorization.GetRoleDefinition({
              scope: `/subscriptions/${subscriptionId}`,
              roleDefinitionId,
            });
            const dataActions = (role.properties?.permissions ?? []).flatMap(
              (p) => p.dataActions ?? [],
            );
            grants.push(`${scope} ${[...dataActions].sort().join(",")}`);
          }
          const send = "Microsoft.EventGrid/events/send/action";
          const receive = "Microsoft.EventGrid/events/receive/action";
          expect(grants.sort()).toEqual(
            [
              `${outputs.topicIds.eventGrid.toLowerCase()} ${send}`,
              `${outputs.topicIds.cloudEvent.toLowerCase()} ${send}`,
              `${outputs.topicIds.custom.toLowerCase()} ${send}`,
              `${outputs.namespaceTopicId.toLowerCase()} ${send}`,
              `${outputs.workersId.toLowerCase()} ${receive}`,
            ].sort(),
          );
        }),
      );
    });
  },
);

// Destroy, then prove no role is left on the Function's identity.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `stack` is undefined when the deploy failed; destroy what it left anyway.
    const outputs = yield* stack;
    if (outputs === undefined) return yield* destroy(Stack);
    const { principalId } = outputs;
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const remaining = yield* collectAll(authorization.ListRoleAssignmentForSubscription, {
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    }).pipe(
      Effect.map((page) => page.value.length),
      // The role-assignment list trails deletes by up to a few minutes.
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (n) => n === 0,
        times: 24,
      }),
    );
    expect(remaining).toEqual(0);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
