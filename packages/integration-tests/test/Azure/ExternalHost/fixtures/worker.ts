import * as Azure from "@alchemy.run/azure";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** The value the Worker reads back through `KeyVault.SecretRead`. */
export const SECRET_VALUE = "from-key-vault";

export const Account = Azure.Storage.StorageAccount("ExternalHostAccount", {});
export const Container = Effect.gen(function* () {
  const account = yield* Account;
  return yield* Azure.Storage.BlobContainer("ExternalHostFiles", {
    storageAccount: account.storageAccountName,
  });
});
export const Jobs = Effect.gen(function* () {
  const account = yield* Account;
  return yield* Azure.Storage.Queue("ExternalHostJobs", {
    storageAccount: account.storageAccountName,
  });
});
export const Vault = Azure.KeyVault.Vault("ExternalHostVault", {
  softDeleteRetentionInDays: 7,
});
export const Secret = Effect.gen(function* () {
  const vault = yield* Vault;
  return yield* Azure.KeyVault.Secret("ExternalHostSecret", {
    vault: vault.vaultName,
    value: Redacted.make(SECRET_VALUE),
  });
});
export const Bus = Azure.ServiceBus.Namespace("ExternalHostBus", { sku: "Basic" });
export const Orders = Effect.gen(function* () {
  const bus = yield* Bus;
  return yield* Azure.ServiceBus.Queue("ExternalHostOrders", {
    namespace: bus.namespaceName,
  });
});
export const Events = Azure.EventHub.Namespace("ExternalHostEvents", { sku: "Basic" });
export const Telemetry = Effect.gen(function* () {
  const events = yield* Events;
  return yield* Azure.EventHub.EventHub("ExternalHostTelemetry", {
    namespace: events.namespaceName,
    partitionCount: 1,
    messageRetentionInDays: 1,
  });
});

/**
 * A Cloudflare Worker using Azure bindings: an external host, so each
 * binding assigns its role to the Entra service principal Alchemy creates
 * for the Worker, and calls sign in with that principal's client secret.
 * One route per binding; each answers `{ ok, result | error }` so a failure
 * surfaces the Azure error in the test.
 */
export default class ExternalHostWorker extends Cloudflare.Worker<ExternalHostWorker>()(
  "AzureExternalHostWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const container = yield* Container;
    const read = yield* Azure.Storage.BlobContainerRead(container);
    const write = yield* Azure.Storage.BlobContainerWrite(container);
    const readWrite = yield* Azure.Storage.BlobContainerReadWrite(container);
    const jobs = yield* Jobs;
    const send = yield* Azure.Storage.QueueSend(jobs);
    const receive = yield* Azure.Storage.QueueReceive(jobs);
    const vaultSecret = yield* Secret;
    const secret = yield* Azure.KeyVault.SecretRead(vaultSecret);
    const ordersQueue = yield* Orders;
    const orders = yield* Azure.ServiceBus.QueueSend(ordersQueue);
    const hub = yield* Telemetry;
    const telemetry = yield* Azure.EventHub.Send(hub);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const key = url.searchParams.get("key") ?? "external-host";
        switch (url.pathname) {
          case "/blob/read-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.put(key, "from-worker", { contentType: "text/plain" });
                const blob = yield* readWrite.get(key);
                const head = yield* readWrite.head(key);
                const listed = yield* readWrite.list({ prefix: key });
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
              Effect.gen(function* () {
                const { etag } = yield* write.put(key, new TextEncoder().encode("bytes"));
                return { etag };
              }),
            );
          case "/blob/read":
            return yield* respond(
              Effect.gen(function* () {
                const blob = yield* read.get(key);
                const missing = yield* read.get(`${key}-missing`);
                const missingHead = yield* read.head(`${key}-missing`);
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
                yield* write.delete(key);
                // Deleting a missing blob succeeds.
                yield* write.delete(key);
                const head = yield* read.head(key);
                return { gone: head === undefined };
              }),
            );
          case "/queue":
            return yield* respond(
              Effect.gen(function* () {
                const sent = yield* send.send(key);
                const messages = yield* receive.receive({ maxMessages: 32 });
                for (const message of messages) yield* receive.delete(message);
                return {
                  messageId: sent.messageId,
                  texts: messages.map((m) => m.text),
                };
              }),
            );
          case "/secret":
            return yield* respond(
              Effect.map(secret.get(), (value) => ({ value: Redacted.value(value) })),
            );
          case "/servicebus":
            return yield* respond(
              Effect.as(orders.send({ key }, { messageId: key }), { sent: true }),
            );
          case "/eventhub":
            return yield* respond(
              Effect.gen(function* () {
                yield* telemetry.send({ key });
                yield* telemetry.sendBatch([
                  { key, n: 1 },
                  { key, n: 2 },
                ]);
                return { sent: 3 };
              }),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
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
