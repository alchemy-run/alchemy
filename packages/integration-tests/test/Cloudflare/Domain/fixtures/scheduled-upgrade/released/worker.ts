/**
 * The Feeds Worker as 2.0.0-beta.85 wrote it, before a schedule's command id
 * only named it (#2806). The roll-forward test installs that release and
 * deploys this file with it; this workspace never type-checks it.
 *
 * `POST /schedule/<id>` schedules `Refresh` as `refresh:1` in a second,
 * `GET /state/<id>` reads how many refreshes ran, and `GET /version` says
 * which release serves.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class Refreshed extends Domain.Event("Refreshed", {}) {}
export class Refresh extends Domain.Command("Refresh", {
  target: Schema.String,
  input: {},
  events: [Refreshed],
}) {}
export class Feed extends Domain.Aggregate("Feed", {
  id: Schema.String,
  state: Schema.Struct({ refreshes: Schema.Number }),
  initial: { refreshes: 0 },
  commands: [Refresh],
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
        if (path === "/version") return yield* HttpServerResponse.json({ release: "released" });
        const [, action, id] = path.match(ROUTE) ?? [];
        if (action === "schedule") {
          const outcome = yield* feeds
            .schedule(id!, new Refresh({}), { commandId: "refresh:1", after: "1 second" })
            .pipe(
              Effect.as("Scheduled"),
              Effect.catchTag("AlreadyExecuted", () => Effect.succeed("AlreadyExecuted")),
            );
          return yield* HttpServerResponse.json({ outcome });
        }
        if (action === "state") return yield* HttpServerResponse.json(yield* feeds.state(id!));
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Feeds.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.layerDurableObjects())),
    ),
  ),
) {}
