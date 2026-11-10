import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Notes } from "./Notes.ts";
import Session from "./Session.ts";
import Workspace from "./Workspace.ts";

/**
 * The HTTP front of both agents:
 *
 * - `/chat/<user>/<conversation>/<action>` reaches a user's `Session`.
 * - `/code/<conversation>/<action>` reaches a `Workspace` with a sandbox.
 * - `/notes/<key>` reads what the `save_note` tool wrote.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* Session;
    const workspaces = yield* Workspace;
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, area, ...rest] = new URL(request.url, "http://api").pathname.split("/");
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};
        const ok = HttpServerResponse.json({ ok: true });

        if (area === "notes") {
          return yield* HttpServerResponse.json({ text: yield* notes.get(rest[0]!) });
        }

        if (area === "code") {
          const [name, action] = rest as [string, string];
          const workspace = workspaces.getByName(name);
          switch (action) {
            case "create":
              return yield* HttpServerResponse.json({ id: yield* workspace.create(name) });
            case "prompt":
              return yield* HttpServerResponse.json({
                status: yield* workspace.prompt(name, body.text, body.requestId),
              });
            case "tool-calls":
              return yield* HttpServerResponse.json(yield* workspace.toolCalls(name));
            case "file":
              return yield* HttpServerResponse.json({
                text: yield* workspace.readFile(name, body.path),
              });
            case "kill":
              yield* workspace.kill(name);
              return yield* ok;
          }
        }

        if (area === "chat") {
          const [user, name, action] = rest as [string, string, string];
          const session = sessions.getByName(user);
          switch (action) {
            case "create":
              return yield* HttpServerResponse.json({
                id: yield* session.create(name, body.tools ?? []),
              });
            case "prompt":
              return yield* HttpServerResponse.json(
                yield* session.prompt(name, body.text, body.requestId),
              );
            case "start":
              return yield* HttpServerResponse.json({
                submission: yield* session.start(name, body.text, body.requestId),
              });
            case "crash":
              // The call fails as the instance dies under it.
              yield* session.crash().pipe(Effect.ignore);
              return yield* ok;
            case "disable-tool":
              yield* session.disableTool(name, body.tool);
              return yield* ok;
            case "enable-tool":
              yield* session.enableTool(name, body.tool);
              return yield* ok;
            case "enable-code-mode":
              yield* session.enableCodeMode(name);
              return yield* ok;
            case "add-skill":
              yield* session.addSkill(name);
              return yield* ok;
            case "tools":
              return yield* HttpServerResponse.json(yield* session.tools(name));
            case "messages":
              return yield* HttpServerResponse.json(yield* session.messages(name));
            case "list":
              return yield* HttpServerResponse.json(yield* session.list());
          }
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
