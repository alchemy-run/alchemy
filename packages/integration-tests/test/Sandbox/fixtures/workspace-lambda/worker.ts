import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { LambdaWorkspace } from "./workspace.ts";

/** POST /<op> with a JSON body; answers JSON. */
export default class LambdaWorkspaceWorker extends Cloudflare.Worker<LambdaWorkspaceWorker>()(
  "LambdaWorkspaceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workspace = yield* LambdaWorkspace;
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
            case "parallel":
              return workspace.open(
                session,
                {},
                Effect.gen(function* () {
                  const box = yield* LambdaWorkspace.Session;
                  yield* Effect.all([box.exec("echo a > a.txt"), box.exec("echo b > b.txt")], {
                    concurrency: "unbounded",
                  });
                  return yield* box.exec("cat a.txt b.txt motd");
                }),
              );
            // One command in an open: on the session's own machine.
            case "open":
              return workspace.open(
                session,
                {},
                Effect.flatMap(LambdaWorkspace.Session, (box) => box.exec(body.command!)),
              );
            // Commands at once, each on a fork.
            case "fanout":
              return Effect.all(
                (JSON.parse(body.commands!) as ReadonlyArray<string>).map((command) =>
                  workspace.exec(session, command),
                ),
                { concurrency: "unbounded" },
              );
            case "history":
              return workspace.history(session, { limit: 50 });
            case "delete":
              return Effect.as(workspace.delete(session), "deleted");
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
