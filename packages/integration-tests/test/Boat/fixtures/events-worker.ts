import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Where Boat delivers on the Worker. */
export const EVENTS_PATH = "/__alchemy/boat/events";

/**
 * The verified deliveries for one sandbox, one object per sandbox id. A
 * Durable Object reads its own writes.
 */
export class SeenBoatEvents extends Cloudflare.DurableObject<SeenBoatEvents>()(
  "SeenBoatEvents",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      return {
        record: Effect.fn(function* (type: string, labelled: boolean) {
          yield* state.storage.put(type, true);
          if (labelled) yield* state.storage.put("labelled", true);
        }),
        seen: Effect.fn(function* () {
          const ready = yield* state.storage.get<boolean>("sandbox.ready");
          const archived = yield* state.storage.get<boolean>("sandbox.archived");
          const labelled = yield* state.storage.get<boolean>("labelled");
          return {
            ready: ready === true,
            archived: archived === true,
            labelled: labelled === true,
          };
        }),
      };
    });
  }),
) {}

export default class BoatEventsWorker extends Cloudflare.Worker<BoatEventsWorker>()(
  "BoatEventsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const seen = yield* SeenBoatEvents;
    const sandboxes = yield* Boat.CreateSandbox();
    yield* Boat.consumeSandboxEvents({ events: ["sandbox.ready", "sandbox.archived"] }, (event) =>
      seen
        .getByName(event.data.sandbox.id)
        .record(event.type, event.data.sandbox.labels?.["alchemy.id"] === "BoatEventsWorker"),
    );
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const sandboxId = url.searchParams.get("sandbox") ?? "";
        // A sandbox of this stack's own, started and stopped.
        if (url.pathname === "/lifecycle") {
          const sandbox = yield* sandboxes.create({
            type: "small",
            noEnv: true,
            autoStop: "10 minutes",
          });
          yield* sandbox.exec("true");
          yield* sandbox.stop();
          return yield* HttpServerResponse.json({ sandboxId: sandbox.sandboxId });
        }
        if (url.pathname === "/delete") {
          yield* sandboxes.delete(sandboxId);
          return yield* HttpServerResponse.json({ deleted: true });
        }
        return yield* HttpServerResponse.json(yield* seen.getByName(sandboxId).seen());
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Boat.SandboxEventsLive, Boat.CreateSandboxHttp))),
) {}
