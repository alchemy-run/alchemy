import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

// Standard: publisher endpoints need it.
export const Hubs = Azure.EventHub.Namespace("EhBindingsHubs", { sku: "Standard" });

/** Every send binding targets this hub; two partitions so partition routing is observable. */
export const Telemetry = Effect.gen(function* () {
  const hubs = yield* Hubs;
  return yield* Azure.EventHub.EventHub("EhBindingsTelemetry", {
    namespace: hubs.namespaceName,
    partitionCount: 2,
    messageRetentionInDays: 1,
  });
});

/** A Basic namespace, where publisher sends fail with `PublisherRequiresStandardTier`. */
export const BasicHubs = Azure.EventHub.Namespace("EhBindingsBasic", { sku: "Basic" });
export const BasicTelemetry = Effect.gen(function* () {
  const hubs = yield* BasicHubs;
  return yield* Azure.EventHub.EventHub("EhBindingsBasicHub", {
    namespace: hubs.namespaceName,
    partitionCount: 1,
    messageRetentionInDays: 1,
  });
});

export const Data = Azure.Storage.StorageAccount("EhBindingsData");

/** The trigger writes one blob per received event (`events/<id>`); the test reads them out of band. */
export const Received = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("EhBindingsReceived", {
    storageAccount: account.storageAccountName,
  });
});

/** Standard event hubs take events up to 1 MB. */
const TOO_LARGE = 1100 * 1024;

/**
 * Answer `{ ok: true, result }`, or `{ ok: false, tag, error }` for a typed
 * failure (status 200, so the caller can assert the tag), or a 500 for a
 * defect so the caller retries.
 */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catch((error) =>
      HttpServerResponse.json({
        ok: false,
        tag: (error as { _tag?: unknown } | undefined)?._tag,
        error: String((error as { message?: unknown } | undefined)?.message ?? error),
      }),
    ),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Read a trigger-metadata member whatever casing the host used. */
const member = (value: unknown, name: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const key = Object.keys(value).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : (value as Record<string, unknown>)[key];
};

const at = (value: unknown, index: number): unknown =>
  Array.isArray(value) ? value[index] : undefined;

/** The `id` of an event body, JSON-decoded or not. */
const idOf = (event: unknown): string | undefined => {
  if (typeof event === "string") {
    try {
      return idOf(JSON.parse(event));
    } catch {
      return undefined;
    }
  }
  const id = member(event, "id");
  return typeof id === "string" ? id : undefined;
};

const event = (id: string) => JSON.stringify({ id });

/**
 * Effect Function with one route per Event Hubs send binding. Each route
 * sends events whose body is `{ "id": … }`; an Event Hubs trigger on the
 * same hub writes `events/<id>` to {@link Received} with the partition,
 * partition key, and custom properties it saw. Routes answer
 * `{ ok, result | tag | error }`, so a caller retries through role
 * propagation (`MessagingUnauthorized`) and asserts typed failures.
 */
export default class EventHubBindingsFunction extends Azure.Functions.Function<EventHubBindingsFunction>()(
  "EventHubBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const hub = yield* Telemetry;
    const received = yield* Received;
    const sendEvent = yield* Azure.EventHub.SendEvent(hub);
    const sendEventBatch = yield* Azure.EventHub.SendEventBatch(hub);
    const sendPartitionEvent = yield* Azure.EventHub.SendPartitionEvent(hub);
    const sendPublisherEvent = yield* Azure.EventHub.SendPublisherEvent(hub);
    const send = yield* Azure.EventHub.Send(hub);
    const basicHub = yield* BasicTelemetry;
    const sendBasicPublisherEvent = yield* Azure.EventHub.SendPublisherEvent(basicHub);
    const records = yield* Azure.Storage.BlobContainerWrite(received);

    yield* Azure.EventHub.consumeEvents(Telemetry, (batch) =>
      Effect.forEach(batch.events, (body, i) => {
        const id = idOf(body);
        if (id === undefined) return Effect.void;
        const partitionContext = member(batch.metadata, "PartitionContext");
        return records
          .put(
            `events/${id}`,
            JSON.stringify({
              partitionId: member(partitionContext, "PartitionId") ?? null,
              partitionKey: at(member(batch.metadata, "PartitionKeyArray"), i) ?? null,
              properties: at(member(batch.metadata, "PropertiesArray"), i) ?? null,
              systemProperties: at(member(batch.metadata, "SystemPropertiesArray"), i) ?? null,
              metadataKeys: Object.keys(batch.metadata).sort(),
            }),
            { contentType: "application/json" },
          )
          .pipe(Effect.asVoid, Effect.orDie);
      }).pipe(Effect.asVoid),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const q = (name: string) => url.searchParams.get(name) ?? "";
        const ids = q("ids").split(",").filter(Boolean);
        switch (url.pathname) {
          case "/op/SendEvent":
            return yield* respond(
              sendEvent({
                body: event(q("id")),
                contentType: "application/json",
                brokerProperties: { partitionKey: q("partitionKey") },
                userProperties: { source: q("source") },
              }),
            );
          case "/op/SendEvent/too-large":
            return yield* respond(sendEvent({ body: "x".repeat(TOO_LARGE) }));
          case "/op/SendEventBatch":
            return yield* respond(
              sendEventBatch({
                events: ids.map((id) => ({
                  body: event(id),
                  brokerProperties: { partitionKey: q("partitionKey") },
                  userProperties: { source: q("source") },
                })),
              }),
            );
          case "/op/SendEventBatch/mismatch":
            return yield* respond(
              sendEventBatch({
                events: ids.map((id) => ({
                  body: event(id),
                  brokerProperties: { partitionKey: id },
                })),
              }),
            );
          case "/op/SendPartitionEvent":
            return yield* respond(
              sendPartitionEvent({
                partitionId: q("partitionId"),
                body: event(q("id")),
                contentType: "application/json",
              }),
            );
          case "/op/SendPublisherEvent":
            return yield* respond(
              sendPublisherEvent({
                publisherId: q("publisherId"),
                body: event(q("id")),
                contentType: "application/json",
              }),
            );
          case "/op/SendPublisherEvent/basic":
            return yield* respond(
              sendBasicPublisherEvent({ publisherId: q("publisherId"), body: event(q("id")) }),
            );
          case "/send/send":
            return yield* respond(
              send.send(
                { id: q("id") },
                { partitionKey: q("partitionKey"), properties: { source: q("source") } },
              ),
            );
          case "/send/batch":
            return yield* respond(
              send.sendBatch(
                ids.map((id) => ({ id })),
                { properties: { source: q("source") } },
              ),
            );
          case "/send/partition":
            return yield* respond(send.sendToPartition(q("partitionId"), { id: q("id") }));
          case "/send/publisher":
            return yield* respond(send.sendAsPublisher(q("publisherId"), { id: q("id") }));
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Functions.EventHubEventSource,
        Azure.EventHub.SendEventHttp,
        Azure.EventHub.SendEventBatchHttp,
        Azure.EventHub.SendPartitionEventHttp,
        Azure.EventHub.SendPublisherEventHttp,
        Azure.EventHub.SendHttp,
        Azure.Storage.BlobContainerWriteHttp,
      ),
    ),
  ),
) {}
