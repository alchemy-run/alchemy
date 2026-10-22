import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { MicroVMWorkspace } from "./workspace.ts";

/** POST /<op> with a JSON body; answers JSON. */
export default class MicroVMWorkspaceWorker extends Cloudflare.Worker<MicroVMWorkspaceWorker>()(
  "MicroVMWorkspaceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workspace = yield* MicroVMWorkspace;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const op = new URL(request.url, "http://x").pathname.slice(1);
        const body = (yield* request.json) as Record<string, string>;
        const session = body.session!;
        const result: unknown = yield* (() => {
          switch (op) {
            case "exec":
              return workspace.exec(session, body.command!);
            // Commands at once, each in a microVM of its own.
            case "fanout":
              return Effect.all(
                (JSON.parse(body.commands!) as ReadonlyArray<string>).map((command) =>
                  workspace.exec(session, command),
                ),
                { concurrency: "unbounded" },
              );
            case "open":
              return workspace.open(
                session,
                {},
                Effect.flatMap(MicroVMWorkspace.Session, (box) => box.exec(body.command!)),
              );
            default:
              return Effect.succeed("ok");
          }
        })();
        return yield* HttpServerResponse.json({ result: result ?? null });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
