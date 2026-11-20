// src/Api.ts
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Ref from "effect/Ref";

/**
 * An Effect program baked into an E2B template. Every sandbox created from
 * the template boots with it serving on port 3000.
 */
export default class Api extends E2B.Template<Api>()(
  "Api",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    // Lives in the sandbox's memory, which E2B keeps when the sandbox pauses.
    const visits = yield* Ref.make(0);
    return {
      fetch: Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(visits, (n) => n + 1);
        return yield* HttpServerResponse.json({ visits: count });
      }).pipe(Effect.orDie),
    };
  }),
) {}
