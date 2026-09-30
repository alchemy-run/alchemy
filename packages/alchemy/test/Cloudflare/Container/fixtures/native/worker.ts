import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { NativeObject } from "./object.ts";

export const NativeWorker = Cloudflare.Worker(
  "NativeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* NativeObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        if (path === "/ready") return HttpServerResponse.text("ready");
        const result = yield* objects
          .getByName("workspace")
          .exec(
            path === "/snapshot"
              ? "snapshot"
              : path === "/stdin"
                ? "stdin"
                : "exec",
          )
          .pipe(Effect.orDie);
        return yield* HttpServerResponse.json(result);
      }),
    };
  }),
);

export default NativeWorker;
