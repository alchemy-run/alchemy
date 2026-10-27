import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { app } from "./app.ts";
import { WorkflowsLive } from "./workflows.ts";

interface NativeInstance {
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): Promise<{ status: string }>;
}

/** The test workflows on Cloudflare Workflows, through NativeEngine. */
export default class NativeEngineWorker extends Cloudflare.Worker<NativeEngineWorker>()(
  "NativeEngineWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const routes = yield* app;
    const env = (yield* Cloudflare.WorkerEnvironment) as Record<
      string,
      { get(id: string): Promise<NativeInstance> }
    >;
    return {
      // `/native/{pause|resume|status}/{workflow}?executionId=` drives the
      // Cloudflare instance behind a run directly, as the dashboard would.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://durable-workflow");
        const [, scope, operation, workflow] = url.pathname.split("/");
        if (scope !== "native") return yield* routes.fetch;
        // NativeEngine names each instance `{workflow}-{executionId}`.
        const id = `${workflow}-${url.searchParams.get("executionId")}`.replace(
          /[^A-Za-z0-9_-]/g,
          "_",
        );
        const instance = yield* Effect.promise(() => env.NativeEngine.get(id));
        if (operation === "pause") yield* Effect.promise(() => instance.pause());
        else if (operation === "resume") yield* Effect.promise(() => instance.resume());
        return yield* HttpServerResponse.json(yield* Effect.promise(() => instance.status()));
      }),
    };
  }).pipe(
    Effect.provide(WorkflowsLive.pipe(Layer.provideMerge(Cloudflare.Workflows.NativeEngine))),
  ),
) {}
