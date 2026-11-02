import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * STACKIT requires a user among a new project's members, and the test profile
 * authenticates as a service account, so the suite is gated on this variable.
 * The prop only matters at deploy; the running Worker never reads it.
 */
export const Probe = Stackit.ResourceManager.Project("ExternalHostProject", {
  owner: process.env.STACKIT_TEST_PROJECT_OWNER,
});

/**
 * A Cloudflare Worker using a STACKIT binding: an external host, so the binding
 * grants on the service account Alchemy creates for the Worker and signs with
 * tokens minted from its key. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class ExternalHostWorker extends Cloudflare.Worker<ExternalHostWorker>()(
  "StackitExternalHostWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const getProject = yield* Stackit.ResourceManager.GetProject(yield* Probe);

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
          case "/project":
            return yield* respond(getProject({}));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Stackit.ResourceManager.GetProjectHttp)),
) {}
