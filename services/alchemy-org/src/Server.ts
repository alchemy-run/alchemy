/**
 * The engineer, running on your machine — an Effectful
 * {@link Local.Vite} service hosting the agent as a detached
 * local process: the {@link Local} provide-list (DriverCore with
 * sqlite durability, the read/run/write toolbox) under the HTTP
 * surface (Routes.ts), with the UI built by Vite and served from the
 * same address.
 *
 * Long-lived machinery (driver run loops) registers on the process
 * Scope — so plain `Effect.provide(Local)` is enough; the fibers
 * survive init returning. Running needs `ANTHROPIC_API_KEY` in the
 * operator's environment (the reconciler passes the shell env
 * through).
 */
import * as AI from "alchemy/AI";
import * as Local from "alchemy/Local";
import * as Workspace from "alchemy/Workspace";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { GeneralEngineer } from "./Engineer.ts";
import { engineerRoutes } from "./Routes.ts";
import { DriverLocal } from "./services/Driver.ts";
import { ReadTools, RunTools, WriteTools } from "./tools/Toolbox.ts";

const workspaceRoot = process.env.CODER_WORKSPACE ?? `${process.cwd()}/../..`;

const WorkspaceLive = Workspace.fixed(workspaceRoot);

/**
 * The whole engineer over LOCAL physics — the charter, the
 * read/run/write toolbox over the trusted-host sandbox
 * (AI.SandboxLocal over one fixed workspace), and the org's
 * assembled driver (services/Driver.ts: AI.DriverLocal +
 * ThreadStorageSqlite + Model + SessionIndexSqlite + ref store). The
 * driver bundle is provideMERGED because the HTTP edge consumes it
 * too: `SessionSockets` for the `/attach` door, `SessionIndex` for
 * the board, `ThreadStorage` for transcripts. Swapping the sandbox
 * layer (a Cloudflare Container, a MicroVM) is the ONLY change a
 * different placement needs — the toolbox is sandbox-agnostic.
 */
export const EngineerLocal = GeneralEngineer.pipe(
  Layer.provide([ReadTools, RunTools, WriteTools]),
  Layer.provide(AI.SandboxLocal),
  Layer.provide(WorkspaceLive),
  Layer.provideMerge(DriverLocal),
  Layer.orDie,
);

export default class EngineerServer extends Local.Vite<EngineerServer>()(
  "Engineer",
  {
    // no port pinned: the runtime binds an ephemeral one and reports it
    // back through the startup handshake — it lands in the `url` output.
    // The UI (ui/, built by Local.Vite at deploy) is served from the
    // SAME server, so there is no second address to keep in sync.
    main: import.meta.url,
    memo: {
      include: ["src/**", "ui/**", "vite.config.ts"],
    },
  },
  Effect.gen(function* () {
    const gateway = yield* AI.SessionSockets;
    const api = yield* HttpRouter.toHttpEffect(yield* engineerRoutes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://local").pathname;
        if (path.startsWith("/attach/")) {
          const [, , term, ...rest] = path.split("/");
          if (!term || rest.length === 0) {
            return HttpServerResponse.text("bad attach path", {
              status: 400,
            });
          }
          return yield* gateway.attach(
            decodeURIComponent(term),
            rest.map(decodeURIComponent).join("/"),
            request,
          );
        }
        return yield* api;
      }),
    };
  }).pipe(Effect.provide(EngineerLocal)),
) {}
