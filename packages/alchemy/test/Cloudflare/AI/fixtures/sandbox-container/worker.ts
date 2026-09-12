import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SandboxObject } from "./object.ts";

/**
 * The HTTP edge for the container-sandbox fixture: `POST /` takes
 * `{ op, args }` and forwards it to the session DO, which runs it on
 * its container through the {@link Sandbox} contract. One route keeps
 * the fixture small while letting the test drive every operation.
 */
export default class SandboxWorker extends Cloudflare.Worker<SandboxWorker>()(
  "SandboxWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* SandboxObject;

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
