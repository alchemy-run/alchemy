/**
 * A front's fetch with one Durable Streams route next to the conformance
 * routes: `/durable-stream/<key>` appends two messages, then reads the
 * stream back.
 */
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { ChatLog } from "./chat-log.ts";
import { Counter } from "./counter-declaration.ts";

export const durableStreamFront = Effect.gen(function* () {
  const counters = yield* Counter;
  const chat = yield* ChatLog;
  const conformance = conformanceFetch(counters);
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const [group, key] = new URL(request.url, "http://front").pathname
        .split("/")
        .filter((segment) => segment.length > 0);
      if (group === "durable-stream" && key !== undefined) {
        yield* chat.appendAll(key, [
          { user: "a", text: "one" },
          { user: "b", text: "two" },
        ]);
        return yield* HttpServerResponse.json(yield* chat.read(key));
      }
      return yield* conformance;
    }).pipe(Effect.orDie),
  };
});
