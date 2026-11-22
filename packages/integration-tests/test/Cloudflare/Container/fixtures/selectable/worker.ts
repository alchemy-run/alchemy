import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Selector } from "./object.ts";

export const SelectableWorker = Cloudflare.Worker(
  "SelectableWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const selectors = yield* Selector;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        if (url.pathname === "/ready") return HttpServerResponse.text("ready");
        if (url.pathname === "/run") {
          const name = url.searchParams.get("box") === "node" ? "node" : "bun";
          const selector = selectors.getByName(url.searchParams.get("object") ?? "default");
          return yield* HttpServerResponse.json(yield* selector.run(name));
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        // Report failures in the body, so a failed step says why.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
);

export default SelectableWorker;
