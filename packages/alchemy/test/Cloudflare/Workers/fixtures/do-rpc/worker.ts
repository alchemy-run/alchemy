import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import * as Cloudflare from "@/Cloudflare";
import { WorkerEnvironmentKVObject } from "./object.ts";

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

        // Observe native option access while performing real Durable Object RPCs.
        if (request.method === "GET" && url.pathname === "/colo") {
          const name = url.searchParams.get("name") ?? "default";
          // Match the query param against the hints Cloudflare accepts rather
          // than casting it — an unrecognised one is dropped, so a typo in a
          // test reads as "no hint" instead of reaching the runtime.
          const hint = LOCATION_HINTS.find(
            (candidate) => candidate === url.searchParams.get("hint"),
          );
          let locationHintRead = false;
          const object = objects.getByName(
            name,
            hint
              ? {
                  get locationHint() {
                    locationHintRead = true;
                    return hint;
                  },
                }
              : undefined,
          );
          const id = yield* object.identity().pipe(Effect.orDie);
          const colo = yield* object.colo().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ id, colo, locationHintRead });
        }

        // The same name addresses a different object inside a jurisdiction,
        // so the two ids differ when `jurisdiction()` is honoured.
        if (request.method === "GET" && url.pathname === "/jurisdiction") {
          const name = url.searchParams.get("name") ?? "default";
          const global = yield* objects.getByName(name).identity().pipe(Effect.orDie);
          const eu = yield* objects
            .jurisdiction("eu")
            .getByName(name)
            .identity()
            .pipe(Effect.orDie);
          const euAgain = yield* objects
            .jurisdiction("eu")
            .getByName(name)
            .identity()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ global, eu, euAgain });
        }

        // Every way of addressing an instance, reported as the id each one
        // actually reached.
        if (request.method === "GET" && url.pathname === "/addressing") {
          const name = url.searchParams.get("name") ?? "default";
          const id = objects.idFromName(name);
          const uniqueId = objects.newUniqueId();
          const byName = yield* objects.getByName(name).identity().pipe(Effect.orDie);
          const byId = yield* objects.get(id).identity().pipe(Effect.orDie);
          const byIdString = yield* objects
            .get(objects.idFromString(id.toString()))
            .identity()
            .pipe(Effect.orDie);
          const unique = yield* objects.get(uniqueId).identity().pipe(Effect.orDie);
          const otherUnique = yield* objects
            .get(objects.newUniqueId())
            .identity()
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            idFromName: id.toString(),
            byName,
            byId,
            byIdString,
            uniqueId: uniqueId.toString(),
            unique,
            otherUnique,
          });
        }

        // Calling a method the object does not define fails instead of
        // resolving to `undefined` (e.g. an untyped caller, or a stub newer
        // than the deployed object).
        if (request.method === "GET" && url.pathname === "/unknown-rpc") {
          const object = objects.getByName("unknown-rpc") as unknown as {
            missing: () => Effect.Effect<unknown, Error>;
          };
          const missing = yield* object.missing().pipe(
            Effect.match({
              onFailure: (error) => String(error.message),
              onSuccess: (value) => `unexpected success: ${String(value)}`,
            }),
          );
          return yield* HttpServerResponse.json({ missing });
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
