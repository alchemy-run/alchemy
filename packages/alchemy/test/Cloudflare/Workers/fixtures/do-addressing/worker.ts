import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AddressingObject } from "./object.ts";

/**
 * Exercises every way the namespace lets you address an instance. Each route
 * bumps the target instance's own counter and returns it, so a test can tell
 * which instance it actually reached:
 *  - `GET /by-name`     → `getByName(name)`
 *  - `GET /by-id`       → `get(idFromName(name))`
 *  - `GET /by-id-string`→ `get(idFromString(idFromName(name).toString()))`
 *  - `GET /by-unique`   → `get(newUniqueId())`, twice, to prove ids are unique
 *
 * All but the first were declared on the namespace but never implemented, so
 * these routes 500 with "not a function" against a namespace that only wires
 * up `getByName`.
 */
export default Cloudflare.Worker(
  "AddressingWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const objects = yield* AddressingObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";

        if (url.pathname === "/by-name") {
          const count = yield* objects.getByName(name).bump();
          return yield* HttpServerResponse.json({ count });
        }

        if (url.pathname === "/by-id") {
          const count = yield* objects.get(objects.idFromName(name)).bump();
          return yield* HttpServerResponse.json({ count });
        }

        // Round-trips the id through its string form — the shape a caller uses
        // when an id arrives from outside the isolate (a URL, a queue message).
        if (url.pathname === "/by-id-string") {
          const id = objects.idFromName(name);
          const count = yield* objects
            .get(objects.idFromString(id.toString()))
            .bump();
          return yield* HttpServerResponse.json({ count });
        }

        // Two fresh unique ids must be two different instances, so each counter
        // starts from scratch and both report 1.
        if (url.pathname === "/by-unique") {
          const first = yield* objects.get(objects.newUniqueId()).bump();
          const second = yield* objects.get(objects.newUniqueId()).bump();
          return yield* HttpServerResponse.json({ first, second });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        // Surface failures as 5xx text rather than a thrown defect, so a test
        // sees the real error instead of an opaque connection drop.
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(String(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }),
);
