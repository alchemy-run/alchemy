import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import {
  EXPIRY,
  ExpireHold,
  HOLD_WINDOW,
  Hold,
  HoldDeadlineLive,
  Holds,
  PlaceHold,
  ReleaseHold,
} from "./holds.ts";

const HoldsLive = Holds.layer(HoldDeadlineLive).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/**
 * `POST /place/<id>`, `POST /release/<id>`, `GET /state/<id>` on the Holds
 * model; `POST /schedule/<id>` and `POST /cancel/<id>` schedule and cancel
 * the hold's expiry directly; `POST /rearm/<id>` schedules it in one second
 * with `replace: "always"`.
 */
const ROUTE = /^\/(place|release|state|schedule|rearm|cancel)\/([^/]+)$/;

export default class DomainScheduleWorker extends Cloudflare.Worker<DomainScheduleWorker>()(
  "DomainScheduleWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const holds = yield* Hold;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = ROUTE.exec(new URL(request.url, "http://localhost").pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const id = decodeURIComponent(route[2]!);
        if (route[1] === "schedule" || route[1] === "rearm") {
          const scheduled = yield* holds
            .schedule(
              id,
              new ExpireHold(),
              route[1] === "rearm"
                ? { after: "1 second", commandId: EXPIRY, replace: "always" }
                : { after: HOLD_WINDOW, commandId: EXPIRY },
            )
            .pipe(
              Effect.map((receipt) => ({
                commandId: receipt.commandId,
                at: DateTime.toEpochMillis(receipt.at),
              })),
              Effect.catchTag("AlreadyExecuted", (e) => Effect.succeed({ failed: e._tag })),
            );
          return yield* HttpServerResponse.json(scheduled);
        }
        if (route[1] === "cancel")
          return yield* HttpServerResponse.json({
            cancel: yield* holds.unschedule(id, EXPIRY).pipe(
              Effect.as("Cancelled"),
              Effect.catchTag(["AlreadyExecuted", "AlreadyCancelled", "NotScheduled"], (e) =>
                Effect.succeed(e._tag),
              ),
            ),
          });
        if (route[1] === "place") yield* holds.send(id, new PlaceHold());
        if (route[1] === "release") yield* holds.send(id, new ReleaseHold());
        return yield* HttpServerResponse.json(yield* holds.state(id));
      }),
    };
  }).pipe(Effect.provide(HoldsLive)),
) {}
