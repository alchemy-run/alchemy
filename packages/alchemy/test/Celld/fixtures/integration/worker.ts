import { Namespace } from "@/Celld/KV/Namespace.ts";
import { Bucket } from "@/Celld/R2/Bucket.ts";
import { Worker } from "@/Celld/Worker.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { kvBindingConformance } from "../../KV/fixtures/worker.ts";
import { r2BindingConformance } from "../../R2/fixtures/worker.ts";

export default class IntegrationWorker extends Worker<IntegrationWorker>()(
  "IntegrationWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const namespace = yield* Namespace.ref("KV");
    const bucket = yield* Bucket.ref("FILES");
    const kv = yield* kvBindingConformance(namespace);
    const r2 = yield* r2BindingConformance(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = yield* Effect.sync(
          () => new URL(request.url, "http://integration").pathname,
        );
        if (pathname === "/kv") return yield* kv.fetch;
        if (pathname === "/r2") return yield* r2.fetch;
        return yield* HttpServerResponse.json({
          runtime: "celld",
          integration: "bundled-effect-worker",
        });
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json({ error: String(error) }, { status: 500 }),
        ),
      ),
    };
  }),
) {}
