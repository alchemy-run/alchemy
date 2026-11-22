import * as Azure from "@alchemy.run/azure";
import * as servicebus from "@distilled.cloud/azure/servicebus-messaging";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the Effect fixture consumes. Module-scope so tests can yield the
// same declarations.

/** The value `/secret` reads back through `KeyVault.SecretRead`. */
export const SECRET_VALUE = "from-key-vault";

export const Data = Azure.Storage.StorageAccount("FnData");

const container = (id: string) =>
  Effect.gen(function* () {
    const account = yield* Data;
    return yield* Azure.Storage.BlobContainer(id, { storageAccount: account.storageAccountName });
  });

const storageQueue = (id: string) =>
  Effect.gen(function* () {
    const account = yield* Data;
    return yield* Azure.Storage.Queue(id, { storageAccount: account.storageAccountName });
  });

/** Where every handler records that it ran (`<source>/<id>`). */
export const Results = container("FnResults");
/** Uploads here fire the blob-created and Event Grid sources. */
export const Uploads = container("FnUploads");
/** Container the blob binding routes read and write. */
export const Files = container("FnFiles");

/** Consumed by the queue trigger. */
export const Jobs = storageQueue("FnJobs");
/** Sent to and received from by the queue binding routes (no trigger). */
export const Inbox = storageQueue("FnInbox");

export const Vault = Azure.KeyVault.Vault("FnVault", { softDeleteRetentionInDays: 7 });
export const Secret = Effect.gen(function* () {
  const vault = yield* Vault;
  return yield* Azure.KeyVault.Secret("FnSecret", {
    vault: vault.vaultName,
    value: Redacted.make(SECRET_VALUE),
  });
});

// Standard: topics need it.
export const Bus = Azure.ServiceBus.Namespace("FnBus", { sku: "Standard" });
export const Orders = Effect.gen(function* () {
  const bus = yield* Bus;
  return yield* Azure.ServiceBus.Queue("FnOrders", { namespace: bus.namespaceName });
});
export const Events = Effect.gen(function* () {
  const bus = yield* Bus;
  return yield* Azure.ServiceBus.Topic("FnEvents", { namespace: bus.namespaceName });
});
export const Audit = Effect.gen(function* () {
  const bus = yield* Bus;
  const events = yield* Events;
  return yield* Azure.ServiceBus.Subscription("FnAudit", {
    namespace: bus.namespaceName,
    topic: events.topicName,
  });
});

export const Hubs = Azure.EventHub.Namespace("FnHubs", { sku: "Basic" });
export const Telemetry = Effect.gen(function* () {
  const hubs = yield* Hubs;
  return yield* Azure.EventHub.EventHub("FnTelemetry", {
    namespace: hubs.namespaceName,
    partitionCount: 1,
    messageRetentionInDays: 1,
  });
});

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const idOf = (body: unknown) => (body as { id?: unknown } | undefined)?.id;

/**
 * Effect-native Azure Function exercising the runtime and the Azure
 * bindings on a managed-identity host: `fetch`, a timer, one handler per
 * event source, and one route per binding. Each event-source handler writes
 * `<source>/<id>` to {@link Results} (through `BlobContainerReadWrite`);
 * tests read it back with `GET /result?key=…`.
 *
 * Binding routes answer `{ ok, result | error }` with a 500 on error, so a
 * caller retries through role propagation and a real failure shows the
 * Azure error.
 */
export default class EffectFunction extends Azure.Functions.Function<EffectFunction>()(
  "EffectFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
    env: {
      GREETING: Config.String("AZURE_FN_EFFECT_GREETING").pipe(Config.withDefault("hello")),
    },
  },
  Effect.gen(function* () {
    const host = yield* Azure.Functions.Function;
    const resultsContainer = yield* Results;
    const uploadsContainer = yield* Uploads;
    const filesContainer = yield* Files;
    const jobsQueue = yield* Jobs;
    const inboxQueue = yield* Inbox;
    const vaultSecret = yield* Secret;
    const ordersQueue = yield* Orders;
    const telemetryHub = yield* Telemetry;
    const results = yield* Azure.Storage.BlobContainerReadWrite(resultsContainer);
    const uploads = yield* Azure.Storage.BlobContainerWrite(uploadsContainer);
    const filesRead = yield* Azure.Storage.BlobContainerRead(filesContainer);
    const filesWrite = yield* Azure.Storage.BlobContainerWrite(filesContainer);
    const filesReadWrite = yield* Azure.Storage.BlobContainerReadWrite(filesContainer);
    const jobsSend = yield* Azure.Storage.QueueSend(jobsQueue);
    const inboxSend = yield* Azure.Storage.QueueSend(inboxQueue);
    const inboxReceive = yield* Azure.Storage.QueueReceive(inboxQueue);
    const secret = yield* Azure.KeyVault.SecretRead(vaultSecret);
    const ordersSend = yield* Azure.ServiceBus.QueueSend(ordersQueue);
    const telemetrySend = yield* Azure.EventHub.Send(telemetryHub);

    // Service Bus has no topic-send binding: grant the role through the
    // Function's binding contract and call distilled directly.
    const events = yield* Events;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind`Fixture.TopicSender(${host})`({
        roleAssignments: [
          {
            roleDefinitionId: Azure.Authorization.BuiltInRole.ServiceBusDataSender,
            scope: events.topicId,
          },
        ],
      });
    }
    const busName = yield* events.namespaceName;
    const eventsName = yield* events.topicName;
    // Runs as the app's managed identity once deployed.
    const sendMessage = yield* Azure.AzureBindings.withCredentials(servicebus.SendMessage);

    const record = (key: string, value: unknown) =>
      results
        .put(key, JSON.stringify(value), { contentType: "application/json" })
        .pipe(Effect.asVoid, Effect.orDie);

    yield* Azure.Functions.schedule("minutely", "0 * * * * *", (run) =>
      record("timer/last", { at: new Date().toISOString(), isPastDue: run.isPastDue }),
    );

    yield* Azure.Storage.consumeQueueMessages(Jobs, (message) =>
      record(`queue/${idOf(message.body)}`, { dequeueCount: message.dequeueCount }),
    );
    yield* Azure.Storage.consumeBlobCreated(Uploads, { prefix: "blob/" }, (event) =>
      record(`blob/${event.blobName.slice("blob/".length)}`, { url: event.url }),
    );
    const data = yield* Data;
    yield* Azure.EventGrid.consumeEvents(
      "UploadEvents",
      {
        scope: data.storageAccountId,
        includedEventTypes: ["Microsoft.Storage.BlobCreated"],
        subjectBeginsWith: "/blobServices/default/containers/",
        subjectEndsWith: ".eg",
      },
      (event) =>
        record(`eventgrid/${event.subject.split("/").pop()?.replace(/\.eg$/, "")}`, {
          eventType: event.eventType,
        }),
    );
    yield* Azure.ServiceBus.consumeQueueMessages(Orders, (message) =>
      record(`servicebus-queue/${idOf(message.body)}`, { deliveryCount: message.deliveryCount }),
    );
    yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) =>
      record(`servicebus-topic/${idOf(message.body)}`, { messageId: message.messageId }),
    );
    yield* Azure.EventHub.consumeEvents(Telemetry, (batch) =>
      Effect.forEach(batch.events, (event) =>
        record(`eventhub/${idOf(event)}`, { size: batch.events.length }),
      ).pipe(Effect.asVoid),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/hello":
            return text(`${process.env.GREETING ?? "missing"} from azure`);

          // Event-source producers.
          case "/result": {
            const found = yield* results.get(key).pipe(Effect.orDie);
            return found === undefined ? text("missing", 404) : text(found.text());
          }
          case "/upload":
            return yield* respond(uploads.put(key, "uploaded"));
          case "/queue/send":
            return yield* respond(jobsSend.send(JSON.stringify({ id })));
          case "/servicebus/queue":
            return yield* respond(ordersSend.send({ id }));
          case "/servicebus/topic": {
            const namespaceName = yield* busName;
            const entityPath = yield* eventsName;
            return yield* respond(
              sendMessage({
                namespaceName,
                entityPath,
                body: JSON.stringify({ id }),
                contentType: "application/json",
              }),
            );
          }
          case "/eventhub":
            return yield* respond(telemetrySend.send({ id }));

          // Binding routes.
          case "/blob/read-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* filesReadWrite.put(key, "from-function", { contentType: "text/plain" });
                const blob = yield* filesReadWrite.get(key);
                const head = yield* filesReadWrite.head(key);
                const listed = yield* filesReadWrite.list({ prefix: key });
                return {
                  text: blob?.text(),
                  size: head?.size,
                  contentType: head?.contentType,
                  keys: listed.blobs.map((b) => b.key),
                };
              }),
            );
          case "/blob/write":
            return yield* respond(
              Effect.map(
                filesWrite.put(key, new TextEncoder().encode(url.searchParams.get("value") ?? "")),
                ({ etag }) => ({ etag }),
              ),
            );
          case "/blob/read":
            return yield* respond(
              Effect.gen(function* () {
                const blob = yield* filesRead.get(key);
                const missing = yield* filesRead.get(`${key}-missing`);
                const missingHead = yield* filesRead.head(`${key}-missing`);
                return {
                  text: blob?.text(),
                  missing: missing === undefined,
                  missingHead: missingHead === undefined,
                };
              }),
            );
          case "/blob/delete":
            return yield* respond(
              Effect.gen(function* () {
                yield* filesWrite.delete(key);
                // Deleting a missing blob succeeds.
                yield* filesWrite.delete(key);
                const head = yield* filesRead.head(key);
                return { gone: head === undefined };
              }),
            );
          case "/inbox":
            return yield* respond(
              Effect.gen(function* () {
                const sent = yield* inboxSend.send(key);
                const messages = yield* inboxReceive.receive({ maxMessages: 32 });
                for (const message of messages) yield* inboxReceive.delete(message);
                return { messageId: sent.messageId, texts: messages.map((m) => m.text) };
              }),
            );
          case "/secret":
            return yield* respond(
              Effect.map(secret.get(), (value) => ({ value: Redacted.value(value) })),
            );
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Functions.StorageQueueEventSource,
        Azure.Functions.BlobCreatedEventSource,
        Azure.Functions.EventGridEventSource,
        Azure.Functions.ServiceBusQueueEventSource,
        Azure.Functions.ServiceBusSubscriptionEventSource,
        Azure.Functions.EventHubEventSource,
        Azure.Storage.BlobContainerReadHttp,
        Azure.Storage.BlobContainerWriteHttp,
        Azure.Storage.BlobContainerReadWriteHttp,
        Azure.Storage.QueueSendHttp,
        Azure.Storage.QueueReceiveHttp,
        Azure.KeyVault.SecretReadHttp,
        Azure.ServiceBus.QueueSendHttp,
        Azure.EventHub.SendHttp,
      ),
    ),
  ),
) {}
