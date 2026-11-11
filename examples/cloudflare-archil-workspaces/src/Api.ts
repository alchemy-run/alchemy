import * as Archil from "@alchemy.run/archil";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Agent, Template } from "./Workspace.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const disks = yield* Archil.CreateDisk();
    const templates = yield* Archil.BranchDisk(Template);
    const sandboxes = yield* Archil.CreateSandbox(Agent);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, user, action] = url.pathname.split("/");
        if (!user) return HttpServerResponse.text("GET /<user>/notes", { status: 400 });

        // Disks created at run time stay when the stack is destroyed, so
        // removing a user deletes their home disk.
        if (action === undefined && request.method === "DELETE") {
          yield* disks.delete(`home-${user}`);
          return yield* HttpServerResponse.json({ deleted: user });
        }

        // Each user gets a home disk, created on first use.
        const home = yield* disks.create(`home-${user}`);

        if (action === "notes" && request.method === "POST") {
          const body = yield* request.text;
          yield* home.append("notes.md", `- ${body}\n`);
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (action === "notes") {
          const notes = yield* home
            .getText("notes.md")
            .pipe(Effect.catchTag("NoSuchKey", () => Effect.succeed("")));
          return HttpServerResponse.text(notes);
        }

        // A scratch branch of the template, for one session.
        if (action === "session") {
          const branch = yield* templates.branch({
            name: `session-${user}`,
            fromCheckpoint: "seeded",
          });
          return yield* HttpServerResponse.json(branch);
        }

        // Run a command in a sandbox with the user's home mounted.
        if (action === "run") {
          const sandbox = yield* sandboxes.create({
            name: `run-${user}`,
            mounts: [{ disk: home, path: "/home/user" }],
            idleTtlSeconds: 120,
          });
          const result = yield* sandbox.exec("wc -l /home/user/notes.md");
          yield* sandbox.delete();
          return HttpServerResponse.text(result.stdout);
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Archil.CreateDiskHttp, Archil.BranchDiskHttp, Archil.CreateSandboxHttp),
    ),
  ),
) {}
