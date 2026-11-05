import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { CloseTicket, OpenTicket, Ticket, Tickets } from "./phases.ts";

const TicketsLive = Tickets.layer(Layer.empty).pipe(
  Layer.provide(DomainCloudflare.layerDurableObjects()),
);

/** `POST /open/<id>` and `POST /close/<id>` answer the state, or the rejection's data. */
const ROUTE = /^\/(open|close)\/([^/]+)$/;

export default class DomainPhasesWorker extends Cloudflare.Worker<DomainPhasesWorker>()(
  "DomainPhasesWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const tickets = yield* Ticket;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const route = ROUTE.exec(new URL(request.url, "http://localhost").pathname);
        if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
        const id = decodeURIComponent(route[2]!);
        const command = route[1] === "open" ? new OpenTicket() : new CloseTicket();
        return yield* tickets.send(id, command).pipe(
          Effect.flatMap(() => tickets.state(id)),
          Effect.catchTag("WrongPhase", ({ _tag, command, phase, allowed }) =>
            Effect.succeed({ _tag, command, phase, allowed }),
          ),
          Effect.flatMap((body) => HttpServerResponse.json(body)),
        );
      }),
    };
  }).pipe(Effect.provide(TicketsLive)),
) {}
