/**
 * The Feeds Worker of `../released/worker.ts`, on this workspace's API: the
 * same Worker, model and aggregate, so an upgrade keeps their Durable Object
 * namespaces and data.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Domain from "@alchemy.run/domain";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class Refreshed extends Domain.Event("Refreshed", {}) {}
export class Refresh extends Domain.Command("Refresh", {
  input: { id: Schema.String },
  events: [Refreshed],
}) {}
export class Feed extends Domain.Aggregate("Feed", {
  id: Schema.String,
  state: Schema.Struct({ refreshes: Schema.Number }),
  initial: { refreshes: 0 },
  commands: [Refresh],
  keyOf: (command) => command.id,
  decide: { Refresh: () => [new Refreshed({})] },
  evolve: { Refreshed: (state) => ({ refreshes: state.refreshes + 1 }) },
}) {}
export class Feeds extends Domain.Model("Feeds", { aggregates: [Feed] }) {}

const ROUTE = /^\/(schedule|state)\/([^/]+)$/;

export default class FeedsWorker extends Cloudflare.Worker<FeedsWorker>()(
  "FeedsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const feeds = yield* Feed;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        if (path === "/version") return yield* HttpServerResponse.json({ release: "current" });
        const [, action, id] = path.match(ROUTE) ?? [];
        if (action === "schedule") {
          yield* feeds.schedule(new Refresh({ id: id! }), {
            commandId: "refresh:1",
            after: "1 second",
          });
          return yield* HttpServerResponse.json({ outcome: "Scheduled" });
        }
        if (action === "state") return yield* HttpServerResponse.json(yield* feeds.get(id!));
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        // The cause, so a failing call says why.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Feeds.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.layerDurableObjects())),
    ),
  ),
) {}
