import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const DurableObjectWorkerEnvironmentKV = Cloudflare.KVNamespace(
  "DurableObjectWorkerEnvironmentKV",
  {
    title: "durable-object-worker-environment-kv",
  },
);

export class WorkerEnvironmentKVObject extends Cloudflare.DurableObjectNamespace<WorkerEnvironmentKVObject>()(
  "WorkerEnvironmentKVObject",
  Effect.gen(function* () {
    const kv = yield* Cloudflare.KVNamespace.bind(
      DurableObjectWorkerEnvironmentKV,
    );

    return Effect.gen(function* () {
      return {
        put: (key: string, value: string) => kv.put(key, value),
        get: (key: string) => kv.get(key),
      };
    });
  }).pipe(Effect.provide(Cloudflare.KVNamespaceBindingLive)),
) {}

export default class DurableObjectWorkerEnvironmentWorker extends Cloudflare.Worker<DurableObjectWorkerEnvironmentWorker>()(
  "DurableObjectWorkerEnvironmentWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
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

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
