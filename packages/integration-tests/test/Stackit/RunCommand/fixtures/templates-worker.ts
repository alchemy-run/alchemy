import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** `ListCommandTemplates` needs no server, so it doesn't wait behind the slow flag. */
export default class RunCommandTemplatesWorker extends Cloudflare.Worker<RunCommandTemplatesWorker>()(
  "StackitRunCommandTemplatesWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const listTemplates = yield* Stackit.RunCommand.ListCommandTemplates();
    return {
      fetch: listTemplates({ osType: "linux" }).pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Stackit.RunCommand.ListCommandTemplatesHttp)),
) {}
