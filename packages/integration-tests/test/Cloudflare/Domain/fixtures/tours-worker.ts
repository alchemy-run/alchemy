import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BookTour, CancelTour, OrgBusy, OrgId, OrgSchedule, Tour, Tours } from "./tours.ts";

const ToursLive = Tours.layer(Layer.empty).pipe(Layer.provide(DomainCloudflare.DurableObjects));

/**
 * `POST /book/<tour>/<org>/<unit>` and `POST /cancel/<tour>/<org>` answer with
 * the org's schedule once it has applied the write; `GET /schedule/<org>`,
 * `GET /events/<org>` and `GET /busy/<org>` read the org's views.
 */
const ROUTE = /^\/(book|cancel|schedule|events|busy)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/;

export default class DomainToursWorker extends Cloudflare.Worker<DomainToursWorker>()(
  "DomainToursWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const tours = yield* Tour;
    const schedules = yield* OrgSchedule;
    const busy = yield* OrgBusy;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = ROUTE.exec(new URL(request.url, "http://localhost").pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const [, action, first, second, third] = route.map((part) =>
          part === undefined ? undefined : decodeURIComponent(part),
        );
        if (action === "book" || action === "cancel") {
          const orgId = OrgId.make(second!);
          const receipt = yield* tours.send(
            first!,
            action === "book" ? new BookTour({ orgId, unit: third! }) : new CancelTour({ orgId }),
          );
          const state = yield* schedules.query(orgId, {
            atLeast: { stream: receipt.stream, version: receipt.version },
          });
          return yield* HttpServerResponse.json(Option.getOrNull(state));
        }
        const orgId = OrgId.make(first!);
        if (action === "schedule")
          return yield* HttpServerResponse.json(Option.getOrNull(yield* schedules.query(orgId)));
        if (action === "events") {
          const { entries } = yield* schedules.list(orgId);
          return yield* HttpServerResponse.json(
            entries.map((entry) => ({ id: entry.envelope.id, open: entry.event.open })),
          );
        }
        return yield* HttpServerResponse.json(Option.getOrNull(yield* busy.query(orgId)));
      }).pipe(
        // The view has not caught up with the write yet: the caller retries.
        Effect.catchTag("ConsistencyTimeout", () =>
          Effect.succeed(HttpServerResponse.text("not caught up", { status: 503 })),
        ),
      ),
    };
  }).pipe(Effect.provide(ToursLive)),
) {}
