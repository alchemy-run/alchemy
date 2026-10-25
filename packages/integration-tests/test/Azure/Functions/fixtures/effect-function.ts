import * as Azure from "@alchemy.run/azure";
import * as eventhubs from "@distilled.cloud/azure/eventhubs-messaging";
import * as servicebus from "@distilled.cloud/azure/servicebus-messaging";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as queue from "@distilled.cloud/azure/storage-queue";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the Effect fixture consumes. Module-scope so tests can yield the
// same declarations.

export const Data = Azure.Storage.StorageAccount("FnData");

const container = (id: string) =>
  Effect.gen(function* () {
    const account = yield* Data;
    return yield* Azure.Storage.BlobContainer(id, { storageAccount: account.storageAccountName });
  });

/** Where every handler records that it ran (`<source>/<id>`). */
export const Results = container("FnResults");
/** Uploads here fire the blob-created and Event Grid sources. */
export const Uploads = container("FnUploads");

export const Jobs = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.Queue("FnJobs", { storageAccount: account.storageAccountName });
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
  });
});

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

const { BuiltInRole } = Azure.Authorization;

/**
 * Effect-native Azure Function exercising the runtime itself: `fetch`, a
 * timer, and one handler per event source. Each handler writes
 * `<source>/<id>` to {@link Results}; tests read it back with
 * `GET /result?key=…`. The routes that produce events call distilled
 * operations directly with the app's managed identity (the bootstrap
 * provides it), and the fixture grants itself the roles through the
 * Function's binding contract, so this suite does not depend on the
 * binding layers (`Bindings.test.ts` covers those).
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
    const data = yield* Data;
    const results = yield* Results;
    const uploads = yield* Uploads;
    const jobs = yield* Jobs;
    const orders = yield* Orders;
    const events = yield* Events;
    const audit = yield* Audit;
    const telemetry = yield* Telemetry;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind`Fixture.Producers(${host})`({
        roleAssignments: [
          { roleDefinitionId: BuiltInRole.StorageBlobDataContributor, scope: results.containerId },
          { roleDefinitionId: BuiltInRole.StorageBlobDataContributor, scope: uploads.containerId },
          { roleDefinitionId: BuiltInRole.StorageQueueDataMessageSender, scope: jobs.queueId },
          { roleDefinitionId: BuiltInRole.ServiceBusDataSender, scope: orders.queueId },
          { roleDefinitionId: BuiltInRole.ServiceBusDataSender, scope: events.topicId },
          { roleDefinitionId: BuiltInRole.EventHubsDataSender, scope: telemetry.eventHubId },
        ],
      });
    }
    // Accessors for attribute values at runtime (bound into app settings).
    const accountName = yield* data.storageAccountName;
    const resultsName = yield* results.containerName;
    const uploadsName = yield* uploads.containerName;
    const jobsName = yield* jobs.queueName;
    const busName = yield* orders.namespaceName;
    const ordersName = yield* orders.queueName;
    const eventsName = yield* events.topicName;
    const hubsName = yield* telemetry.namespace;
    const telemetryName = yield* telemetry.eventHubName;

    const blobUrl = Effect.map(accountName, (name) => `https://${name}.blob.core.windows.net`);
    const record = (key: string, value: unknown) =>
      Effect.gen(function* () {
        const url = yield* blobUrl;
        const containerName = yield* resultsName;
        yield* blob.UploadBlockBlob({
          url,
          containerName,
          blob: key,
          body: new TextEncoder().encode(JSON.stringify(value)),
          xMsBlobContentType: "application/json",
        });
      }).pipe(Effect.orDie);

    yield* Azure.Functions.schedule("yearly", "0 0 0 1 1 *", () => Effect.void);

    yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
      record(`queue/${(message.body as { id: string }).id}`, {
        dequeueCount: message.dequeueCount,
      }),
    );
    yield* Azure.Storage.consumeBlobCreated(uploads, { prefix: "blob/" }, (event) =>
      record(`blob/${event.blobName.slice("blob/".length)}`, { url: event.url }),
    );
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
    yield* Azure.ServiceBus.consumeQueueMessages(orders, (message) =>
      record(`servicebus-queue/${(message.body as { id: string }).id}`, {
        deliveryCount: message.deliveryCount,
      }),
    );
    yield* Azure.ServiceBus.consumeSubscriptionMessages(audit, (message) =>
      record(`servicebus-topic/${(message.body as { id: string }).id}`, {
        messageId: message.messageId,
      }),
    );
    yield* Azure.EventHub.consumeEvents(telemetry, (batch) =>
      Effect.forEach(batch.events, (event) =>
        record(`eventhub/${(event as { id: string }).id}`, { size: batch.events.length }),
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
          case "/result": {
            const accountUrl = yield* blobUrl;
            const containerName = yield* resultsName;
            const found = yield* blob
              .DownloadBlob({ url: accountUrl, containerName, blob: key })
              .pipe(
                Effect.map((res) => new TextDecoder().decode(res.body)),
                Effect.catchTag("BlobNotFound", () => Effect.succeed(undefined)),
              );
            return found === undefined ? text("missing", 404) : text(found);
          }
          case "/upload": {
            const accountUrl = yield* blobUrl;
            const containerName = yield* uploadsName;
            yield* blob.UploadBlockBlob({
              url: accountUrl,
              containerName,
              blob: key,
              body: new TextEncoder().encode("uploaded"),
            });
            return text("ok");
          }
          case "/queue/send": {
            const account = yield* accountName;
            const queueName = yield* jobsName;
            yield* queue.MessagesEnqueue({
              url: `https://${account}.queue.core.windows.net`,
              queueName,
              MessageText: JSON.stringify({ id }),
            });
            return text("ok");
          }
          case "/servicebus/queue":
          case "/servicebus/topic": {
            const namespaceName = yield* busName;
            const entityPath =
              url.pathname === "/servicebus/queue" ? yield* ordersName : yield* eventsName;
            yield* servicebus.SendMessage({
              namespaceName,
              entityPath,
              body: JSON.stringify({ id }),
              contentType: "application/json",
            });
            return text("ok");
          }
          case "/eventhub": {
            const namespaceName = yield* hubsName;
            const eventHubName = yield* telemetryName;
            yield* eventhubs.SendEvent({
              namespaceName,
              eventHubName,
              body: JSON.stringify({ id }),
              contentType: "application/json",
            });
            return text("ok");
          }
          default:
            return text("not found", 404);
        }
      }).pipe(Effect.orDie),
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
      ),
    ),
  ),
) {}
