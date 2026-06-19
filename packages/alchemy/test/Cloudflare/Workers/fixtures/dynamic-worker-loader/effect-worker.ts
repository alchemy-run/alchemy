import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * Effect-native Worker fixture for the Worker Loader binding. Yielding
 * `Cloudflare.WorkerLoader(name)` during Init registers the
 * `worker_loader` binding on this Worker and returns the runtime handle in one
 * step — no separate `.bind(...)`. The fetch handler loads an isolated dynamic
 * Worker from inline source and proxies the request to it over Effect-native
 * HTTP.
 */
export default class DynamicLoaderEffectWorker extends Cloudflare.Worker<DynamicLoaderEffectWorker>()(
  "DynamicLoaderEffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const loader = yield* Cloudflare.WorkerLoader("LOADER");

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        const worker = yield* loader.load({
          compatibilityDate: "2026-01-28",
          mainModule: "worker.js",
          modules: {
            "worker.js": `export default {
              async fetch() {
                return Response.json({ mode: "effect", ok: true });
              }
            }`,
          },
        });

        return yield* worker.fetch(request).pipe(Effect.orDie);
      }),
    };
  }),
) {}
