import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The webhook the events worker's subscription creates, read back with ReadWebhook. */
export const EVENTS_PATH = "/__alchemy/e2b/events";

/**
 * The verified deliveries for one sandbox, one object per sandbox id. A
 * Durable Object reads its own writes; KV cached a read made before the
 * delivery landed as "missing" for a minute.
 */
export class SeenEvents extends Cloudflare.DurableObject<SeenEvents>()(
  "SeenEvents",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      return {
        record: Effect.fn(function* (type: string) {
          yield* state.storage.put(type, true);
        }),
        seen: Effect.fn(function* () {
          const created = yield* state.storage.get<boolean>("sandbox.lifecycle.created");
          const killed = yield* state.storage.get<boolean>("sandbox.lifecycle.killed");
          return { created: created === true, killed: killed === true };
        }),
      };
    });
  }),
) {}

export default class E2BEventsWorker extends Cloudflare.Worker<E2BEventsWorker>()(
  "E2BEventsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const seen = yield* SeenEvents;
    yield* E2B.consumeSandboxEvents(
      { events: ["sandbox.lifecycle.created", "sandbox.lifecycle.killed"] },
      (event) => seen.getByName(event.sandbox_id).record(event.type),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const sandboxId = url.searchParams.get("sandbox") ?? "";
        const events = yield* seen.getByName(sandboxId).seen();
        return yield* HttpServerResponse.json(events);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(E2B.SandboxEventsLive)),
) {}
