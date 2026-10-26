import * as Azure from "@alchemy.run/azure";
import { ServerHost } from "alchemy/Runtime/Process";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Network } from "./Network.ts";
import { AdminKey, Jobs, LOCATION, PORT, Results, VM_SIZE } from "./resources.ts";

/** A job on the queue: the text to process and the id of its result blob. */
interface Job {
  readonly id: string;
  readonly text: string;
}

/**
 * A job API and a background worker on one Azure virtual machine.
 *
 * - `GET /` answers `ok`.
 * - `POST /jobs` enqueues the request body as a job and answers `202` with its id.
 * - `GET /jobs/:id` returns the job's result, or `404` while it is pending.
 *
 * A loop next to the HTTP server drains the `Jobs` queue every 2 seconds and
 * writes each result (the text in upper case) to the `Results` container.
 *
 * Alchemy bundles this file for Node.js 22, stages it in a storage account it
 * creates, and installs it on the VM as a systemd unit with a managed run
 * command (no SSH). The program runs as the VM's system-assigned managed
 * identity. The bindings grant that identity only the roles they need, each
 * on its one resource.
 */
export default class Server extends Azure.Compute.VirtualMachine<Server>()(
  "Server",
  Effect.gen(function* () {
    const { nic } = yield* Network;
    const key = yield* AdminKey;
    return {
      main: import.meta.url,
      location: LOCATION,
      vmSize: VM_SIZE,
      port: PORT,
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "azureuser",
      sshPublicKeys: [key.publicKey.as<string>()],
    };
  }),
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const send = yield* Azure.Storage.QueueSend(jobs);
    const inbox = yield* Azure.Storage.QueueReceive(jobs);
    const container = yield* Results;
    const results = yield* Azure.Storage.BlobContainerReadWrite(container);

    // The worker: receive a batch, write each result, then delete the message.
    // A failed round (for example while a new role assignment propagates) is
    // logged, and the next round tries again.
    const host = yield* ServerHost;
    yield* host.run(
      Effect.gen(function* () {
        const messages = yield* inbox.receive({ maxMessages: 16 });
        for (const message of messages) {
          const job = yield* Effect.try(() => JSON.parse(message.text) as Job);
          yield* results.put(`jobs/${job.id}`, job.text.toUpperCase(), {
            contentType: "text/plain",
          });
          yield* inbox.delete(message);
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("job round failed", Cause.pretty(cause))),
        Effect.repeat(Schedule.spaced("2 seconds")),
        Effect.asVoid,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const [collection, id] = url.pathname.split("/").filter(Boolean);

        if (collection === undefined && request.method === "GET") {
          return HttpServerResponse.text("ok");
        }

        if (collection === "jobs" && id === undefined && request.method === "POST") {
          const text = yield* request.text;
          const jobId = yield* Effect.sync(() => crypto.randomUUID());
          const job: Job = { id: jobId, text };
          yield* send.send(JSON.stringify(job));
          return yield* HttpServerResponse.json({ id: job.id }, { status: 202 });
        }

        if (collection === "jobs" && id !== undefined && request.method === "GET") {
          const result = yield* results.get(`jobs/${id}`);
          return result === undefined
            ? HttpServerResponse.text("pending", { status: 404 })
            : HttpServerResponse.text(result.text());
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("request failed", Cause.pretty(cause)).pipe(
            Effect.as(HttpServerResponse.text("internal error", { status: 500 })),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Storage.QueueSendHttp,
        Azure.Storage.QueueReceiveHttp,
        Azure.Storage.BlobContainerReadWriteHttp,
      ),
    ),
  ),
) {}
