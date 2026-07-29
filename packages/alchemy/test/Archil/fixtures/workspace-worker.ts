import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Workspace } from "./workspace-do.ts";

/**
 * Worker fronting the per-user {@link Workspace} Durable Objects. The Worker
 * itself binds nothing from Archil — it routes by name and the DO owns the
 * disk.
 */
export default class ArchilWorkspaceWorker extends Cloudflare.Worker<ArchilWorkspaceWorker>()(
  "ArchilWorkspaceWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const workspaces = yield* Workspace;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        // One workspace — one DO instance, one disk — per user.
        const workspace = workspaces.getByName(
          url.searchParams.get("user") ?? "anon",
        );

        if (url.pathname === "/run") {
          const result = yield* workspace.run(
            "echo hello-from-do >> /mnt/archil/log.txt && wc -l < /mnt/archil/log.txt",
          );
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/search") {
          const result = yield* workspace.search("hello-from-do");
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/template") {
          const result = yield* workspace.readTemplate();
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/destroy") {
          yield* workspace.destroy();
          return yield* HttpServerResponse.json({ destroyed: true });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
