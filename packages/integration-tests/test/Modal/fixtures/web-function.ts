import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Services } from "./services.ts";

/** A web function: Modal routes its `*.modal.run` URL to `fetch`. */
export default class Web extends Modal.Function<Web>()(
  "Web",
  { main: import.meta.url, app: Services, web: true },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return yield* HttpServerResponse.json({
          kind: "web",
          path: new URL(request.url, "http://web").pathname,
        });
      }),
    };
  }),
) {}
