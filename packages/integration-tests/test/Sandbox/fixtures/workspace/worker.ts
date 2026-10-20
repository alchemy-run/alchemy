import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { TestWorkspace } from "./workspace.ts";

class Failed extends Data.TaggedError("Failed")<{ readonly stderr: string }> {}

/** POST /<op> with a JSON body; answers JSON. */
export default class WorkspaceWorker extends Cloudflare.Worker<WorkspaceWorker>()(
  "WorkspaceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workspace = yield* TestWorkspace;
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
            // Two commands at once in one open, then a third that sees both.
            case "parallel":
              return workspace.open(
                session,
                {},
                Effect.gen(function* () {
                  const box = yield* TestWorkspace.Session;
                  yield* Effect.all([box.exec("echo a > a.txt"), box.exec("echo b > b.txt")], {
                    concurrency: "unbounded",
                  });
                  return yield* box.exec("cat a.txt b.txt motd");
                }),
              );
            // Writes, then fails: the write is still snapshotted.
            case "fail":
              return workspace
                .open(
                  session,
                  {},
                  Effect.gen(function* () {
                    const box = yield* TestWorkspace.Session;
                    yield* box.exec("echo written-before-failing > failed.txt");
                    return yield* new Failed({ stderr: "on purpose" });
                  }),
                )
                .pipe(Effect.catchTag("Failed", () => Effect.succeed("failed")));
            // Two opens at once: one mount, one snapshot.
            case "overlap":
              return Effect.all(
                [1, 2].map((n) =>
                  workspace.open(
                    session,
                    {},
                    Effect.flatMap(TestWorkspace.Session, (box) =>
                      box.exec(`echo ${n} > overlap-${n}.txt && sleep 2`),
                    ),
                  ),
                ),
                { concurrency: "unbounded" },
              );
            case "fork":
              return Effect.as(workspace.fork(body.from!, session), "forked");
            case "undo":
              return Effect.as(workspace.undo(session), "undone");
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
