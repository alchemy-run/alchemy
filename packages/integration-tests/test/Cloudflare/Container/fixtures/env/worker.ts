import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { EnvObject } from "./object.ts";

/** `GET /env` echoes the container's `process.env` for every env case. */
export default Cloudflare.Worker(
  "EnvWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const objects = yield* EnvObject;
    return {
      fetch: Effect.gen(function* () {
        const env = yield* objects.getByName("default").readEnv();
        return yield* HttpServerResponse.json(env);
      }).pipe(
        Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 503 })),
        ),
      ),
    };
  }),
);
