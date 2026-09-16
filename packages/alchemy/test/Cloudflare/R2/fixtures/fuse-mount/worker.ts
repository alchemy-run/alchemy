import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { FuseObject } from "./object.ts";

/**
 * The HTTP edge for the FUSE-mount fixture: `POST /` takes
 * `{ op, args }` and forwards it to the DO, which runs it against its
 * container's mounted filesystem.
 */
export default class FuseWorker extends Cloudflare.Worker<FuseWorker>()(
  "FuseWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* FuseObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method !== "POST") {
          return HttpServerResponse.text("ok");
        }
        const {
          op,
          args = [],
          session = "default",
        } = (yield* request.json) as {
          op: string;
          args?: ReadonlyArray<unknown>;
          session?: string;
        };
        const object = objects.getByName(session);
        const call = (
          object as unknown as Record<
            string,
            (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
          >
        )[op];
        if (typeof call !== "function") {
          return HttpServerResponse.text(`unknown op: ${op}`, { status: 400 });
        }
        return yield* HttpServerResponse.json(yield* call(...args));
      }).pipe(
        // fixture: every failure mode comes back as readable text
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`CAUSE: ${cause}`, { status: 599 }),
          ),
        ),
      ),
    };
  }),
) {}
