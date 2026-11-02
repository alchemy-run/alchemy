import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Audit = Effect.gen(function* () {
  const router = yield* Stackit.Telemetry.Router("LinkBindingsRouter", {});
  const token = yield* Stackit.Telemetry.AccessToken("LinkBindingsToken", {
    routerId: router.routerId,
  });
  return yield* Stackit.Telemetry.Link("LinkBindingsLink", {
    routerId: router.routerId,
    accessToken: token.accessToken,
  });
});

/**
 * A Cloudflare Worker with the bindings on a project's link. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class LinkBindingsWorker extends Cloudflare.Worker<LinkBindingsWorker>()(
  "StackitLinkBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const link = yield* Audit;
    const getLink = yield* Stackit.Telemetry.GetProjectLink(link);
    const backflush = yield* Stackit.Telemetry.BackflushProject(link);
    const getJob = yield* Stackit.Telemetry.GetProjectBackflushJob(link);
    const listJobs = yield* Stackit.Telemetry.ListProjectBackflushJobs(link);

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
        const id = url.searchParams.get("id") ?? "";
        switch (url.pathname) {
          case "/get-link":
            // Without the token, which never leaves the Worker.
            return yield* respond(
              getLink({}).pipe(
                Effect.map((live) => ({ id: live.id, status: live.status, enabled: live.enabled })),
              ),
            );
          case "/backflush":
            return yield* respond(backflush({ displayName: "alchemy-replay" }));
          case "/get-job":
            return yield* respond(getJob({ backflushJobId: id }));
          case "/list-jobs":
            return yield* respond(listJobs({ pageSize: 100 }));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Stackit.Telemetry.GetProjectLinkHttp),
    Effect.provide(Stackit.Telemetry.BackflushProjectHttp),
    Effect.provide(Stackit.Telemetry.GetProjectBackflushJobHttp),
    Effect.provide(Stackit.Telemetry.ListProjectBackflushJobsHttp),
  ),
) {}
