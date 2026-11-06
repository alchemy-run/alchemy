import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Services } from "./services.ts";

/** A Server behind Modal's proxy auth (the default). */
export default class Api extends Modal.Server<Api>()(
  "Api",
  { main: import.meta.url, app: Services, routingRegion: "us-east" },
  Effect.gen(function* () {
    return {
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
