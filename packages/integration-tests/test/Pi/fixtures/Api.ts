import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Notes } from "./infra.ts";
import PiSession from "./Session.ts";

export default class PiApi extends Cloudflare.Worker<PiApi>()(
  "PiApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* PiSession;
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, user, name, action] = url.pathname.split("/");
        const session = sessions.getByName(user!);
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};

        switch (action) {
          case "create":
            return yield* HttpServerResponse.json({ id: yield* session.create(name!, body.tools) });
          case "prompt":
            return yield* HttpServerResponse.json(
              yield* session.prompt(name!, body.text, body.requestId),
            );
          case "disable":
            yield* session.disable(name!, body.tool);
            return yield* HttpServerResponse.json({ ok: true });
          case "enable":
            yield* session.enable(name!, body.tool);
            return yield* HttpServerResponse.json({ ok: true });
          case "tools":
            return yield* HttpServerResponse.json(yield* session.tools(name!));
          case "transcript":
            return yield* HttpServerResponse.json(yield* session.transcript(name!));
          case "list":
            return yield* HttpServerResponse.json(yield* session.list());
          case "note":
            return yield* HttpServerResponse.json({ text: yield* notes.get(name!) });
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.KV.ReadWriteNamespaceBinding))),
) {}
