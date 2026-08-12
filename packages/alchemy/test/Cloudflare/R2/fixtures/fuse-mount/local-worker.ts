import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { LocalFuseObject } from "./local-object.ts";
import { LocalFusePersist } from "./local-storage.ts";

/**
 * The dev-mode HTTP edge. Beyond the `{ op, args }` dispatch the live
 * fixture has, this worker also binds the bucket NATIVELY:
 *
 * - `GET  /object?key=…` reads through the worker's `r2_bucket` binding
 * - `POST /object?key=…` writes through it
 *
 * so the test can prove the FUSE mount and the worker binding share ONE
 * local data plane — a file written through the filesystem inside the
 * container is an object the binding sees, and vice versa.
 */
export default class LocalFuseWorker extends Cloudflare.Worker<LocalFuseWorker>()(
  "LocalFuseWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* LocalFuseObject;
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(LocalFusePersist);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://local");

        if (url.pathname === "/object") {
          const key = url.searchParams.get("key") ?? "";
          if (request.method === "POST") {
            const body = yield* request.text;
            yield* bucket.put(key, body).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true });
          }
          const object = yield* bucket.get(key).pipe(Effect.orDie);
          const text =
            object === null ? null : yield* object.text().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ text });
        }

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
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
