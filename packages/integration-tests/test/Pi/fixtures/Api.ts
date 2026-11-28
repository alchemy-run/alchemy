import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import PiEffectSession from "./EffectSession.ts";
import { Notes } from "./infra.ts";
import PiMcpSession from "./McpSession.ts";
import PiSandboxSession from "./SandboxSession.ts";
import PiSession from "./Session.ts";

export default class PiApi extends Cloudflare.Worker<PiApi>()(
  "PiApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* PiSession;
    const sandboxSessions = yield* PiSandboxSession;
    const mcpSessions = yield* PiMcpSession;
    const effectSessions = yield* PiEffectSession;
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, user, name, action] = url.pathname.split("/");
        const session = sessions.getByName(user!);
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};

        if (user === "mcp") {
          const session = mcpSessions.getByName(name!);
          switch (action) {
            case "create":
              return yield* HttpServerResponse.json({
                id: yield* session.create(name!, body.withServer, body.programs === true),
              });
            case "section":
              return yield* HttpServerResponse.json({ section: yield* session.section(name!) });
            case "tools":
              return yield* HttpServerResponse.json(yield* session.tools(name!));
            case "add-server":
              yield* session.addServer(name!);
              return yield* HttpServerResponse.json({ ok: true });
            case "remove-server":
              yield* session.removeServer(name!);
              return yield* HttpServerResponse.json({ ok: true });
            case "prompt":
              return yield* HttpServerResponse.json({
                status: yield* session.prompt(name!, body.text, body.requestId),
              });
            case "results":
              return yield* HttpServerResponse.json(yield* session.results(name!));
          }
        }
        if (user === "effect") {
          const session = effectSessions.getByName(name!);
          switch (action) {
            case "create":
              return yield* HttpServerResponse.json({ id: yield* session.create(name!) });
            case "prompt":
              return yield* HttpServerResponse.json(
                yield* session.prompt(name!, body.text, body.requestId),
              );
            case "results":
              return yield* HttpServerResponse.json(yield* session.toolResults(name!));
            case "offered":
              return yield* HttpServerResponse.json(yield* session.offered(name!));
            case "section":
              return yield* HttpServerResponse.json({ section: yield* session.section(name!) });
          }
        }
        if (user === "sandbox") {
          const session = sandboxSessions.getByName(name!);
          switch (action) {
            case "create":
              return yield* HttpServerResponse.json({ id: yield* session.create(name!) });
            case "prompt":
              return yield* HttpServerResponse.json({
                status: yield* session.prompt(name!, body.text, body.requestId),
              });
            case "file":
              return yield* HttpServerResponse.json({
                text: yield* session.readFile(name!, body.path),
              });
            case "tools":
              return yield* HttpServerResponse.json(yield* session.toolsUsed(name!));
            case "state":
              return yield* HttpServerResponse.json({ state: yield* session.sandboxState(name!) });
            case "suspend":
              yield* session.suspend(name!);
              return yield* HttpServerResponse.json({ ok: true });
            case "kill":
              yield* session.kill(name!);
              return yield* HttpServerResponse.json({ ok: true });
          }
        }
        switch (action) {
          case "create":
            return yield* HttpServerResponse.json({ id: yield* session.create(name!, body.tools) });
          case "prompt":
            return yield* HttpServerResponse.json(
              yield* session.prompt(name!, body.text, body.requestId),
            );
          case "start":
            return yield* HttpServerResponse.json({
              submission: yield* session.start(name!, body.text, body.requestId),
            });
          case "crash":
            yield* session.crash().pipe(Effect.ignore);
            return yield* HttpServerResponse.json({ ok: true });
          case "phase":
            if (body.phase !== undefined) yield* session.setPhase(name!, body.phase);
            return yield* HttpServerResponse.json(yield* session.phase(name!));
          case "answered":
            return yield* HttpServerResponse.json({ answered: yield* session.answered(name!) });
          case "codemode":
            yield* session.addCodeMode(name!);
            return yield* HttpServerResponse.json({ ok: true });
          case "offered":
            return yield* HttpServerResponse.json(yield* session.offered(name!));
          case "section":
            return yield* HttpServerResponse.json({ section: yield* session.section(name!) });
          case "results":
            return yield* HttpServerResponse.json(yield* session.toolResults(name!));
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
          case "resume":
            yield* session.resume();
            return yield* HttpServerResponse.json({ ok: true });
          case "inspect":
            return yield* HttpServerResponse.json(yield* session.inspect(name!));
          case "list":
            return yield* HttpServerResponse.json(yield* session.list());
          case "note":
            return yield* HttpServerResponse.json({ text: yield* notes.get(name!) });
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(
        // Answer with the failure, so a test can say what went wrong.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.KV.ReadWriteNamespaceBinding))),
) {}
