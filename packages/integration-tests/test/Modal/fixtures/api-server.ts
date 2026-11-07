import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { Services } from "./services.ts";

/** A Server behind Modal's proxy auth (the default). */
export default class Api extends Modal.Server<Api>()(
  "Api",
  { main: import.meta.url, app: Services, routingRegion: "us-east" },
  Effect.gen(function* () {
    return {
      /** An RPC method next to `fetch`. */
      greet: Effect.fn(function* (name: string) {
        return `hello ${name}`;
      }),
      /** A streaming RPC method. */
      letters: (word: string) => Stream.fromIterable(word.split("")),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return yield* HttpServerResponse.json({
          kind: "server",
          path: new URL(request.url, "http://api").pathname,
        });
      }),
    };
  }),
) {}
