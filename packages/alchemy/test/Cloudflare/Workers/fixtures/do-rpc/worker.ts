import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MissingKey, WorkerEnvironmentKVObject } from "./object.ts";

/** The regions a DO can be hinted toward, as `/colo` accepts them. */
const LOCATION_HINTS: readonly Cloudflare.DurableObjectLocationHint[] = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "oc",
  "afr",
  "me",
];

export default class DurableObjectWorkerEnvironmentWorker extends Cloudflare.Worker<DurableObjectWorkerEnvironmentWorker>()(
  "DurableObjectWorkerEnvironmentWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* WorkerEnvironmentKVObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/roundtrip") {
          const object = objects.getByName("default");
          const key = "durable-object-worker-environment";
          yield* object.put(key, "ok").pipe(Effect.orDie);
          const value = yield* object.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        // A typed failure raised inside the object must reach the caller as an
        // instance of its class, not the plain object it crossed the stub as.
        if (request.method === "GET" && url.pathname === "/typed-error") {
          const object = objects.getByName("default");
          const outcome = yield* object.require("no-such-key").pipe(
            Effect.map(() => ({ failed: false, instance: false })),
            Effect.catchTag("MissingKey", (error) =>
              Effect.succeed({
                failed: true,
                instance: error instanceof MissingKey,
                key: error.key,
              }),
            ),
            Effect.orDie,
          );
          return yield* HttpServerResponse.json(outcome);
        }

        // Create a DO instance under a `locationHint` and report the colo it
        // actually landed in. The name must be one no request has addressed
        // before: a hint only steers *creation*.
        if (request.method === "GET" && url.pathname === "/colo") {
          const name = url.searchParams.get("name") ?? "default";
          // Match the query param against the hints Cloudflare accepts rather
          // than casting it — an unrecognised one is dropped, so a typo in a
          // test reads as "no hint" instead of reaching the runtime.
          const hint = LOCATION_HINTS.find(
            (candidate) => candidate === url.searchParams.get("hint"),
          );
          const object = objects.getByName(
            name,
            hint ? { locationHint: hint } : undefined,
          );
          const colo = yield* object.colo().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ colo });
        }

        // Mirrors the tutorial's `/tick/:n` route verbatim — forwards the
        // Stream returned by the DO's `tick` RPC method straight onto the
        // HTTP response.
        // https://alchemy.run/cloudflare/compute/durable-objects
        if (request.method === "GET" && url.pathname.startsWith("/tick/")) {
          const n = Number(url.pathname.split("/").pop()!);
          const stream = objects
            .getByName("tick")
            .tick(n)
            .pipe(
              Stream.map((i) => `${i}\n`),
              Stream.encodeText,
            );
          return HttpServerResponse.stream(stream, {
            headers: { "content-type": "text/plain" },
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
