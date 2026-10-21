import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { MergeWorkspace } from "./workspace.ts";

/** POST /<op> with a JSON body; answers JSON. */
export default class MergeWorker extends Cloudflare.Worker<MergeWorker>()(
  "MergeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workspace = yield* MergeWorkspace;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const op = new URL(request.url, "http://x").pathname.slice(1);
        const body = (yield* request.json) as {
          readonly session: string;
          readonly command?: string;
          readonly commands?: ReadonlyArray<string>;
          readonly from?: string;
        };
        const session = body.session;
        const result: unknown = yield* (() => {
          switch (op) {
            case "exec":
              return workspace.exec(session, body.command!);
            // Commands at once, each on its own fork, timed.
            case "parallel":
              return Effect.gen(function* () {
                const started = Date.now();
                const results = yield* Effect.all(
                  body.commands!.map((command) =>
                    Effect.map(workspace.exec(session, command), (result) => ({
                      ...result,
                      ms: Date.now() - started,
                    })),
                  ),
                  { concurrency: "unbounded" },
                );
                return { results, ms: Date.now() - started };
              });
            case "merge":
              return workspace.merge(body.from!, session);
            case "open":
              return workspace.open(
                session,
                {},
                Effect.flatMap(MergeWorkspace.Session, (box) => box.exec(body.command!)),
              );
            case "fork":
              return Effect.as(workspace.fork(body.from!, session), "forked");
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
