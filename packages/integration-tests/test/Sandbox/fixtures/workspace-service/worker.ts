import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schedule from "effect/Schedule";
import { ServiceWorkspace } from "./workspace.ts";

/** POST /<op> with a JSON body; answers JSON. */
export default class ServiceWorkspaceWorker extends Cloudflare.Worker<ServiceWorkspaceWorker>()(
  "ServiceWorkspaceWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workspace = yield* ServiceWorkspace;
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
            // Commands at once, each on a fork.
            case "fanout":
              return Effect.all(
                (JSON.parse(body.commands!) as ReadonlyArray<string>).map((command) =>
                  workspace.exec(session, command),
                ),
                { concurrency: "unbounded" },
              );
            // A command in an open: on the session's mounted head.
            case "open":
              return workspace.open(
                session,
                {},
                Effect.flatMap(ServiceWorkspace.Session, (box) => box.exec(body.command!)),
              );
            // A server in an open, reached on its port, then stopped.
            case "port":
              return workspace.open(
                session,
                {},
                Effect.scoped(
                  Effect.gen(function* () {
                    const box = yield* ServiceWorkspace.Session;
                    yield* box.spawn(
                      `node -e "require('http').createServer((q, s) => s.end('from ' + q.url)).listen(3000)"`,
                    );
                    const port = yield* box.port(3000);
                    const response = yield* port
                      .fetch(HttpClientRequest.get("/hello"))
                      .pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }));
                    return yield* response.text;
                  }),
                ),
              );
            case "fork":
              return Effect.as(workspace.fork(session, body.to!), "forked");
            case "merge":
              return workspace.merge(session, body.into!);
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
