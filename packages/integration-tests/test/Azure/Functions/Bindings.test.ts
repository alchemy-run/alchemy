import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
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
import EffectFunction, {
  Audit,
  Events,
  Files,
  Inbox,
  Jobs,
  Orders,
  Results,
  SECRET_VALUE,
  Secret,
  Telemetry,
  Uploads,
} from "./fixtures/effect-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureFunctionsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* EffectFunction;
    const results = yield* Results;
    const uploads = yield* Uploads;
    const files = yield* Files;
    const jobs = yield* Jobs;
    const inbox = yield* Inbox;
    const secret = yield* Secret;
    const orders = yield* Orders;
    const events = yield* Events;
    const audit = yield* Audit;
    const telemetry = yield* Telemetry;
    return {
      url: fn.url,
      principalId: fn.principalId,
      resultsId: results.containerId,
      uploadsId: uploads.containerId,
      filesId: files.containerId,
      jobsId: jobs.queueId,
      inboxId: inbox.queueId,
      secretId: secret.secretId,
      ordersId: orders.queueId,
      eventsId: events.topicId,
      auditId: audit.subscriptionResourceId,
      telemetryId: telemetry.eventHubId,
    };
  }),
);

// ~$0.05/run (Service Bus Standard, Event Hubs Basic, Key Vault for ~15 min); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks (tests get them from `test.provider`). */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

/** Poll `/result?key=…` until the event-source handler has recorded `key`. */
const recorded = (key: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}/result?key=${key}`).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status !== 200) return yield* Effect.fail(response.status);
          return yield* response.text;
        }),
      ),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 30 }),
      Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

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

describe("Azure bindings on an Azure Function", { tags: ["provider:azure", "live"] }, () => {
  describe("Storage.BlobContainerReadWrite", () => {
    test(
      "puts, gets, heads, and lists a blob",
      Effect.gen(function* () {
        const body = yield* call("/blob/read-write?key=rw-roundtrip");
        expectOk(body);
        expect(body.result).toEqual({
          text: "from-function",
          size: "from-function".length,
          contentType: "text/plain",
          keys: ["rw-roundtrip"],
        });
      }),
      { timeout: 300_000 },
    );
  });

  describe("Storage.BlobContainerWrite", () => {
    test(
      "uploads bytes and deletes a blob",
      Effect.gen(function* () {
        const written = yield* call("/blob/write?key=write-only&value=bytes");
        expectOk(written);
        expect(written.result.etag).toMatch(/^"?0x[0-9A-F]+"?$/);
        const deleted = yield* call("/blob/delete?key=write-only");
        expectOk(deleted);
        expect(deleted.result).toEqual({ gone: true });
      }),
      { timeout: 300_000 },
    );
  });

  describe("Storage.BlobContainerRead", () => {
    test(
      "reads a blob and reports missing blobs as undefined",
      Effect.gen(function* () {
        expectOk(yield* call("/blob/write?key=read-only&value=bytes"));
        const body = yield* call("/blob/read?key=read-only");
        expectOk(body);
        expect(body.result).toEqual({ text: "bytes", missing: true, missingHead: true });
      }),
      { timeout: 300_000 },
    );
  });

  describe("Storage.QueueSend + Storage.QueueReceive", () => {
    test(
      "enqueues, receives, and deletes a message",
      Effect.gen(function* () {
        const body = yield* call("/inbox?key=queue-roundtrip");
        expectOk(body);
        expect(body.result.messageId).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.result.texts).toEqual(["queue-roundtrip"]);
      }),
      { timeout: 300_000 },
    );
  });

  describe("KeyVault.SecretRead", () => {
    test(
      "reads the secret value",
      Effect.gen(function* () {
        const body = yield* call("/secret");
        expectOk(body);
        expect(body.result).toEqual({ value: SECRET_VALUE });
      }),
      { timeout: 300_000 },
    );
  });

  describe("ServiceBus.QueueSend", () => {
    test(
      "sends a message the queue trigger then receives",
      Effect.gen(function* () {
        expectOk(yield* call("/servicebus/queue?id=binding-sb"));
        const result = yield* recorded("servicebus-queue/binding-sb");
        expect(result.deliveryCount).toBe(1);
      }),
      { timeout: 600_000 },
    );
  });

  describe("EventHub.Send", () => {
    test(
      "sends an event the event hub trigger then receives",
      Effect.gen(function* () {
        expectOk(yield* call("/eventhub?id=binding-eh"));
        const result = yield* recorded("eventhub/binding-eh");
        expect(result.size).toBe(1);
      }),
      { timeout: 600_000 },
    );
  });

  describe("AzureBindings.Bind on a managed-identity host", () => {
    test.provider(
      "assigns each role to the Function's identity, scoped to the bound resource",
      (_stack) =>
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const assignments = (yield* assignmentsOf(outputs.principalId!)).filter(
            // Drop the app's own host-storage grants (scoped to its account).
            (a) => !/\/storageaccounts\/[^/]+$/.test(a),
          );
          const R = Azure.Authorization.BuiltInRole;
          const id = (value: string | undefined) => value!.toLowerCase();
          expect(assignments.sort()).toEqual(
            [
              `${R.StorageBlobDataContributor} ${id(outputs.resultsId)}`,
              `${R.StorageBlobDataContributor} ${id(outputs.uploadsId)}`,
              `${R.StorageBlobDataReader} ${id(outputs.filesId)}`,
              `${R.StorageBlobDataContributor} ${id(outputs.filesId)}`,
              `${R.StorageQueueDataMessageSender} ${id(outputs.jobsId)}`,
              `${R.StorageQueueDataReader} ${id(outputs.jobsId)}`,
              `${R.StorageQueueDataMessageProcessor} ${id(outputs.jobsId)}`,
              `${R.StorageQueueDataMessageSender} ${id(outputs.inboxId)}`,
              `${R.StorageQueueDataMessageProcessor} ${id(outputs.inboxId)}`,
              `${R.KeyVaultSecretsUser} ${id(outputs.secretId)}`,
              `${R.ServiceBusDataSender} ${id(outputs.ordersId)}`,
              `${R.ServiceBusDataReceiver} ${id(outputs.ordersId)}`,
              `${R.ServiceBusDataSender} ${id(outputs.eventsId)}`,
              `${R.ServiceBusDataReceiver} ${id(outputs.auditId)}`,
              `${R.EventHubsDataSender} ${id(outputs.telemetryId)}`,
              `a638d3c7-ab3a-418d-83e6-5f17a39d4fde ${id(outputs.telemetryId)}`,
            ].sort(),
          );
        }),
      { timeout: 120_000 },
    );
  });
});

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
