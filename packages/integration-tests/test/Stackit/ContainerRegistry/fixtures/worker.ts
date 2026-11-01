import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Images = Stackit.ContainerRegistry.Project("RegistryBindingsProject", {});

/**
 * A Cloudflare Worker with every binding over the management API. One route per
 * binding; each answers `{ ok, result | error }` so a failure surfaces the STACKIT
 * error in the test.
 */
export default class RegistryBindingsWorker extends Cloudflare.Worker<RegistryBindingsWorker>()(
  "StackitRegistryBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const images = yield* Images;
    const getProject = yield* Stackit.ContainerRegistry.GetProject(images);
    const listProjects = yield* Stackit.ContainerRegistry.ListProjects(images);
    const listReplicationAdapters =
      yield* Stackit.ContainerRegistry.ListReplicationAdapters(images);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/get-project":
            return yield* respond(getProject({}));
          case "/list-projects":
            return yield* respond(listProjects({ page_size: 100 }));
          case "/list-replication-adapters":
            return yield* respond(listReplicationAdapters({}));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.ContainerRegistry.GetProjectHttp,
        Stackit.ContainerRegistry.ListProjectsHttp,
        Stackit.ContainerRegistry.ListReplicationAdaptersHttp,
      ),
    ),
  ),
) {}
