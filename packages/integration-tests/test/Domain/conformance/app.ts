/**
 * The HTTP routes of the Domain conformance suite, served by each
 * platform's front over the conformance model. Every route is a GET that
 * answers JSON.
 *
 * - `/increment/:id?by=n` sends `Increment`; `{ accepted: total }` or `{ rejected: tag }`
 * - `/again/:id?by=n` sends `Increment` twice under one command id
 * - `/counter/:id`, `/echo/:id`, `/total/:id` read the counter, what the saga wrote, the view
 * - `/place/:id`, `/release/:id`, `/hold/:id` place, release and read a hold
 */
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { Counter, CounterTotal, Echo, Hold, Increment, PlaceHold, ReleaseHold } from "./model.ts";

/** The front's `fetch`, built once the model's services are provided. */
export const app = Effect.gen(function* () {
  const counters = yield* Counter;
  const echoes = yield* Echo;
  const totals = yield* CounterTotal;
  const holds = yield* Hold;
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const url = new URL(request.url, "http://front");
    const [, action, raw] = url.pathname.split("/");
    const id = decodeURIComponent(raw ?? "");
    const by = Number(url.searchParams.get("by") ?? "1");
    const increment = (commandId?: string) =>
      counters.send(id, new Increment({ by }), commandId === undefined ? {} : { commandId }).pipe(
        Effect.map((receipt) => ({ accepted: receipt.reply.total, version: receipt.version })),
        Effect.catchTag("TooBig", (rejection) => Effect.succeed({ rejected: rejection._tag })),
      );
    switch (action) {
      case "ready":
        return HttpServerResponse.text("ok");
      case "increment":
        return yield* HttpServerResponse.json(yield* increment());
      case "again": {
        const first = yield* increment(`again-${id}`);
        const second = yield* increment(`again-${id}`);
        return yield* HttpServerResponse.json({ first, second });
      }
      case "counter":
        return yield* HttpServerResponse.json(yield* counters.get(id));
      case "echo":
        return yield* HttpServerResponse.json(yield* echoes.get(id));
      case "total": {
        const total = yield* totals.get(Counter.ref(id)).pipe(Effect.orDie);
        return yield* HttpServerResponse.json(
          Option.getOrElse(total, () => ({ total: 0, increments: 0 })),
        );
      }
      case "place":
        yield* holds.send(id, new PlaceHold());
        return yield* HttpServerResponse.json(yield* holds.get(id));
      case "release":
        yield* holds.send(id, new ReleaseHold());
        return yield* HttpServerResponse.json(yield* holds.get(id));
      case "hold":
        return yield* HttpServerResponse.json(yield* holds.get(id));
      default:
        return HttpServerResponse.text("Not Found", { status: 404 });
    }
  });
});
