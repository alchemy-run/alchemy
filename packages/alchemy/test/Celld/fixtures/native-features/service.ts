import { Worker } from "@/Celld/Worker.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class NativeService extends Worker<NativeService>()(
  "NativeService",
  { main: import.meta.url },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const body = yield* request.text;
      return yield* HttpServerResponse.json(
        {
          service: "native-service",
          method: request.method,
          body,
          token: request.headers["x-native-token"],
        },
        { headers: { "x-native-service": "yes" } },
      );
    }),
  }),
) {}
