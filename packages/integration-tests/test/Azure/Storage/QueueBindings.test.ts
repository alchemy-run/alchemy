import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as storage from "@distilled.cloud/azure/storage";
import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import QueueFunction, {
  AclGetQueue,
  AclSetQueue,
  ClearQueue,
  DeleteQueue,
  PeekQueue,
  ProcessorQueue,
  PropertiesQueue,
  QueueData,
  ReadQueue,
  ReadWriteQueue,
  ReceiveQueue,
  SendQueue,
  UpdateQueue,
  WriteQueue,
} from "./fixtures/queue-function.ts";

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

const Stack = Alchemy.Stack(
  "AzureStorageQueueBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* QueueFunction;
    const account = yield* QueueData;
    const named = {
      send: yield* SendQueue,
      receive: yield* ReceiveQueue,
      delete: yield* DeleteQueue,
      update: yield* UpdateQueue,
      peek: yield* PeekQueue,
      clear: yield* ClearQueue,
      properties: yield* PropertiesQueue,
      aclGet: yield* AclGetQueue,
      aclSet: yield* AclSetQueue,
      read: yield* ReadQueue,
      write: yield* WriteQueue,
      readWrite: yield* ReadWriteQueue,
      processor: yield* ProcessorQueue,
    };
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      accountName: account.storageAccountName,
      accountId: account.storageAccountId,
      resourceGroup: account.resourceGroup,
      queueNames: {
        send: named.send.queueName,
        receive: named.receive.queueName,
        delete: named.delete.queueName,
        update: named.update.queueName,
        peek: named.peek.queueName,
        clear: named.clear.queueName,
        properties: named.properties.queueName,
        aclGet: named.aclGet.queueName,
        aclSet: named.aclSet.queueName,
        read: named.read.queueName,
        write: named.write.queueName,
        readWrite: named.readWrite.queueName,
        processor: named.processor.queueName,
      },
      queueIds: {
        send: named.send.queueId,
        receive: named.receive.queueId,
        delete: named.delete.queueId,
        update: named.update.queueId,
        peek: named.peek.queueId,
        clear: named.clear.queueId,
        properties: named.properties.queueId,
        aclGet: named.aclGet.queueId,
        aclSet: named.aclSet.queueId,
        read: named.read.queueId,
        write: named.write.queueId,
        readWrite: named.readWrite.queueId,
        processor: named.processor.queueId,
      },
    };
  }),
);

type QueueKey =
  | "send"
  | "receive"
  | "delete"
  | "update"
  | "peek"
  | "clear"
  | "properties"
  | "aclGet"
  | "aclSet"
  | "read"
  | "write"
  | "readWrite"
  | "processor";

// ~$0.01/run (one RA-GRS account, 13 queues, a Flex Consumption app); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks (tests get them from `test.provider`). */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

/** A test whose body also gets the deployer's Azure credentials for out-of-band checks. */
const test = <A, E>(name: string, body: Effect.Effect<A, E, any>, options: { timeout: number }) =>
  baseTest(name, body.pipe(Effect.provide(azure)), options);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (custom roles take a few minutes on the
 * data plane), then return the last answer so a real failure shows its
 * Azure error.
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

/** Queue endpoint signed with an account SAS the deployer lists through ARM. */
const sasEndpoint = (secondary = false) =>
  Effect.gen(function* () {
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
    const host = secondary ? `${accountName}-secondary` : accountName;
    return `https://${host}.queue.core.windows.net/?${accountSasToken}`;
  });

/**
 * Out-of-band queue access, not through the Function's identity: messages
 * with an account SAS, stored access policies (which a SAS cannot touch)
 * with the deployer's ARM-level `queues/getAcl` and `queues/setAcl`.
 * Empties the queue first, so a rerun never sees an earlier run's messages.
 */
const oob = (key: QueueKey) =>
  Effect.gen(function* () {
    const { queueNames, accountName } = yield* stack;
    const url = yield* sasEndpoint();
    const deployerUrl = `https://${accountName}.queue.core.windows.net`;
    const queueName = queueNames[key];
    yield* queues.ClearMessage({ url, queueName });
    return {
      queueName,
      enqueue: (text: string) =>
        queues.MessagesEnqueue({ url, queueName, MessageText: text }).pipe(Effect.map(([m]) => m!)),
      dequeue: () => queues.MessagesDequeue({ url, queueName, numofmessages: 32 }),
      peek: () =>
        queues
          .MessagesPeek({ url, queueName, numofmessages: 32 })
          .pipe(Effect.map((messages) => messages.map((m) => m.MessageText))),
      count: () =>
        queues
          .GetQueueProperties({ url, queueName })
          .pipe(Effect.map((p) => p.xMsApproximateMessagesCount)),
      getAcl: () =>
        queues
          .GetQueueAccessPolicy({ url: deployerUrl, queueName })
          .pipe(Effect.map((policies) => policies.map((p) => p.Id))),
      setAcl: (id: string) =>
        queues.SetQueueAccessPolicy({
          url: deployerUrl,
          queueName,
          body: [
            {
              Id: id,
              AccessPolicy: {
                Start: "2026-01-01T00:00:00Z",
                Expiry: "2030-01-01T00:00:00Z",
                Permission: "r",
              },
            },
          ],
        }),
    };
  });

/** Repeat `effect` until `until` holds (bounded), for approximate counts. */
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, until: (a: A) => boolean) =>
  effect.pipe(Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until, times: 10 }));

const Q = "Microsoft.Storage/storageAccounts/queueServices";

/** `<scope> <sorted actions and data actions>` for every binding role on the Function. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    const grants: string[] = [];
    const customRoles: string[] = [];
    for (const assignment of page.value) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      // Drop the app's own host-storage grants.
      if (hostStorageAccount && scope.endsWith(`/storageaccounts/${hostStorageAccount}`)) continue;
      const roleDefinitionId = assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
      const role = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId,
      });
      if (role.properties?.type === "CustomRole") customRoles.push(roleDefinitionId);
      const permissions = (role.properties?.permissions ?? []).flatMap((p) => [
        ...(p.actions ?? []),
        ...(p.dataActions ?? []),
      ]);
      grants.push(`${scope} ${[...permissions].sort().join(",")}`);
    }
    return { grants: grants.sort(), customRoles };
  });

describe(
  "Azure Storage queue bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("SendQueueMessage", () => {
      test(
        "enqueues a message",
        Effect.gen(function* () {
          const queue = yield* oob("send");
          const body = yield* call("/send?text=send-1");
          expectOk(body);
          expect(body.result.MessageId).toMatch(/^[0-9a-f-]{36}$/);
          expect(yield* queue.peek()).toEqual(["send-1"]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("ReceiveQueueMessages", () => {
      test(
        "dequeues messages and hides them",
        Effect.gen(function* () {
          const queue = yield* oob("receive");
          yield* queue.enqueue("receive-1");
          const body = yield* call("/receive");
          expectOk(body);
          expect(body.result.map((m: queues.DequeuedMessageItem) => m.MessageText)).toEqual([
            "receive-1",
          ]);
          expect(body.result[0].DequeueCount).toEqual(1);
          // Hidden for the 300 s visibility timeout the route asked for.
          expect(yield* queue.peek()).toEqual([]);
          expect(yield* queue.count()).toEqual(1);
        }),
        { timeout: 600_000 },
      );
    });

    describe("DeleteQueueMessage", () => {
      test(
        "deletes a received message",
        Effect.gen(function* () {
          const queue = yield* oob("delete");
          yield* queue.enqueue("delete-1");
          const [received] = yield* queue.dequeue();
          const body = yield* call(
            `/delete?id=${received!.MessageId}&pop=${encodeURIComponent(received!.PopReceipt)}`,
          );
          expectOk(body);
          expect(yield* eventually(queue.count(), (n) => n === 0)).toEqual(0);
        }),
        { timeout: 600_000 },
      );
    });

    describe("UpdateQueueMessage", () => {
      test(
        "replaces a message's text and makes it visible",
        Effect.gen(function* () {
          const queue = yield* oob("update");
          yield* queue.enqueue("before");
          const [received] = yield* queue.dequeue();
          const body = yield* call(
            `/update?id=${received!.MessageId}&pop=${encodeURIComponent(received!.PopReceipt)}&text=after`,
          );
          expectOk(body);
          expect(body.result.popReceipt).not.toEqual(received!.PopReceipt);
          expect(yield* queue.peek()).toEqual(["after"]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("PeekQueueMessages", () => {
      test(
        "reads messages without hiding them",
        Effect.gen(function* () {
          const queue = yield* oob("peek");
          yield* queue.enqueue("peek-1");
          const body = yield* call("/peek");
          expectOk(body);
          expect(
            body.result.map((m: queues.PeekedMessageItem) => [m.MessageText, m.DequeueCount]),
          ).toEqual([["peek-1", 0]]);
          expect(yield* queue.peek()).toEqual(["peek-1"]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("ClearQueueMessages", () => {
      test(
        "deletes every message",
        Effect.gen(function* () {
          const queue = yield* oob("clear");
          yield* queue.enqueue("clear-1");
          yield* queue.enqueue("clear-2");
          expect(yield* queue.peek()).toEqual(["clear-1", "clear-2"]);
          const body = yield* call("/clear");
          expectOk(body);
          expect(yield* queue.peek()).toEqual([]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("GetQueueProperties", () => {
      test(
        "reads the message count and metadata",
        Effect.gen(function* () {
          const queue = yield* oob("properties");
          yield* queue.enqueue("properties-1");
          yield* queue.enqueue("properties-2");
          expect(yield* eventually(queue.count(), (n) => n === 2)).toEqual(2);
          const body = yield* call("/properties");
          expectOk(body);
          expect(body.result).toEqual({ count: 2, purpose: "properties" });
        }),
        { timeout: 600_000 },
      );
    });

    describe("GetQueueAccessPolicy", () => {
      test(
        "reads the stored access policies",
        Effect.gen(function* () {
          const queue = yield* oob("aclGet");
          yield* queue.setAcl("set-out-of-band");
          const body = yield* call("/acl/get");
          expectOk(body);
          expect(body.result).toEqual([
            {
              Id: "set-out-of-band",
              AccessPolicy: {
                Start: "2026-01-01T00:00:00.0000000Z",
                Expiry: "2030-01-01T00:00:00.0000000Z",
                Permission: "r",
              },
            },
          ]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("SetQueueAccessPolicy", () => {
      test(
        "replaces the stored access policies",
        Effect.gen(function* () {
          const queue = yield* oob("aclSet");
          yield* queue.setAcl("replaced-by-function");
          const body = yield* call("/acl/set");
          expectOk(body);
          // A stored access policy can take up to 30 s to take effect.
          const policies = yield* queue.getAcl().pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (ids) => ids.join() === "from-function",
              times: 15,
            }),
          );
          expect(policies).toEqual(["from-function"]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("ListQueues", () => {
      test(
        "lists the account's queues",
        Effect.gen(function* () {
          const { queueNames } = yield* stack;
          const body = yield* call("/queues");
          expectOk(body);
          const ours = Object.values(queueNames).sort();
          expect((body.result as string[]).filter((name) => ours.includes(name)).sort()).toEqual(
            ours,
          );
          const prefixed = yield* call(`/queues?prefix=${queueNames.send}`);
          expectOk(prefixed);
          expect(prefixed.result).toEqual([queueNames.send]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("GetQueueServiceProperties", () => {
      test(
        "reads the queue service properties",
        Effect.gen(function* () {
          const url = yield* sasEndpoint();
          const observed = yield* queues.GetServiceProperties({ url });
          const body = yield* call("/service/properties");
          expectOk(body);
          expect({
            logging: body.result.Logging,
            hourMetrics: body.result.HourMetrics,
            minuteMetrics: body.result.MinuteMetrics,
          }).toEqual({
            logging: observed.Logging,
            hourMetrics: observed.HourMetrics,
            minuteMetrics: observed.MinuteMetrics,
          });
          expect(typeof body.result.HourMetrics.Enabled).toEqual("boolean");
        }),
        { timeout: 600_000 },
      );
    });

    describe("GetQueueServiceStatistics", () => {
      test(
        "reads geo-replication status from the secondary endpoint",
        Effect.gen(function* () {
          const body = yield* call("/service/stats");
          expectOk(body);
          const url = yield* sasEndpoint(true);
          const observed = yield* queues.GetServiceStatistics({ url });
          expect(body.result.GeoReplication.Status).toEqual(observed.GeoReplication?.Status);
        }),
        { timeout: 600_000 },
      );
    });

    describe("QueueRead", () => {
      test(
        "peeks and reads the depth without consuming",
        Effect.gen(function* () {
          const queue = yield* oob("read");
          yield* queue.enqueue("read-1");
          expect(yield* eventually(queue.count(), (n) => n === 1)).toEqual(1);
          const body = yield* call("/read");
          expectOk(body);
          expect(body.result.approximateMessageCount).toEqual(1);
          expect(body.result.metadata.purpose).toEqual("read");
          expect(body.result.texts).toEqual(["read-1"]);
          expect(yield* queue.peek()).toEqual(["read-1"]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("QueueWrite", () => {
      test(
        "sends, updates, deletes, and clears",
        Effect.gen(function* () {
          const queue = yield* oob("write");
          const sent = yield* call("/write/send?text=write-1");
          expectOk(sent);
          expect(yield* queue.peek()).toEqual(["write-1"]);

          const [received] = yield* queue.dequeue();
          const message = `id=${received!.MessageId}&pop=${encodeURIComponent(received!.PopReceipt)}`;
          const updated = yield* call(`/write/update?${message}&text=write-2`);
          expectOk(updated);
          expect(yield* queue.peek()).toEqual(["write-2"]);

          const [again] = yield* queue.dequeue();
          const deleted = yield* call(
            `/write/delete?id=${again!.MessageId}&pop=${encodeURIComponent(again!.PopReceipt)}`,
          );
          expectOk(deleted);
          expect(yield* eventually(queue.count(), (n) => n === 0)).toEqual(0);

          yield* queue.enqueue("write-3");
          const cleared = yield* call("/write/clear");
          expectOk(cleared);
          expect(yield* queue.peek()).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    describe("QueueReadWrite", () => {
      test(
        "sends, receives, updates, peeks, deletes, and clears",
        Effect.gen(function* () {
          const body = yield* call("/readwrite?key=rw");
          expectOk(body);
          expect(body.result).toEqual({
            received: "rw",
            updatedReceipt: true,
            peeked: ["rw-updated"],
            again: "rw-updated",
            countAfterClear: 0,
          });
          const queue = yield* oob("readWrite");
          expect(yield* queue.peek()).toEqual([]);
        }),
        { timeout: 600_000 },
      );
    });

    describe("QueueReceive", () => {
      test(
        "peeks, receives, and deletes",
        Effect.gen(function* () {
          const queue = yield* oob("processor");
          yield* queue.enqueue("processor-1");
          const body = yield* call("/processor");
          expectOk(body);
          expect(body.result).toEqual({ peeked: ["processor-1"], received: ["processor-1"] });
          expect(yield* eventually(queue.count(), (n) => n === 0)).toEqual(0);
        }),
        { timeout: 600_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "assigns exactly each binding's permissions on its queue or account",
        Effect.gen(function* () {
          const outputs = yield* stack;
          const { grants } = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount);
          const ids = outputs.queueIds;
          const at = (scope: string, ...permissions: string[]) =>
            `${scope.toLowerCase()} ${permissions.sort().join(",")}`;
          const reader = [`${Q}/queues/read`, `${Q}/queues/messages/read`];
          expect(grants).toEqual(
            [
              at(ids.send, `${Q}/queues/messages/add/action`),
              at(ids.receive, `${Q}/queues/messages/process/action`),
              at(ids.delete, `${Q}/queues/messages/process/action`),
              at(ids.update, `${Q}/queues/messages/write`),
              at(ids.peek, ...reader),
              at(ids.clear, `${Q}/queues/messages/delete`),
              at(ids.properties, `${Q}/queues/read`),
              at(ids.aclGet, `${Q}/queues/getAcl/action`),
              at(ids.aclSet, `${Q}/queues/setAcl/action`),
              at(outputs.accountId, `${Q}/queues/read`),
              at(outputs.accountId, `${Q}/read`),
              at(ids.read, ...reader),
              at(
                ids.write,
                `${Q}/queues/messages/write`,
                `${Q}/queues/messages/delete`,
                `${Q}/queues/messages/process/action`,
              ),
              at(
                ids.readWrite,
                `${Q}/queues/read`,
                `${Q}/queues/messages/read`,
                `${Q}/queues/messages/write`,
                `${Q}/queues/messages/delete`,
                `${Q}/queues/messages/process/action`,
              ),
              at(ids.processor, `${Q}/queues/messages/read`, `${Q}/queues/messages/process/action`),
            ].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role on the Function's identity and every custom
// role the bindings created is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `stack` is undefined when the deploy failed; destroy what it left anyway.
    const outputs = yield* stack;
    if (outputs === undefined) return yield* destroy(Stack);
    const { principalId, hostStorageAccount } = outputs;
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const { customRoles } = yield* grantsOf(principalId!, hostStorageAccount);
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const remaining = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(
        Effect.map((page) => page.value.length),
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (n) => n === 0, times: 12 }),
      );
    expect(remaining).toEqual(0);
    for (const roleDefinitionId of new Set(customRoles)) {
      const gone = yield* authorization
        .GetRoleDefinition({ scope: `/subscriptions/${subscriptionId}`, roleDefinitionId })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status) => status === "gone",
            times: 12,
          }),
        );
      expect({ roleDefinitionId, gone }).toEqual({ roleDefinitionId, gone: "gone" });
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
