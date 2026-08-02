/**
 * The org, running on your machine — an Effectful {@link Local.Vite}
 * service hosting the factory as a detached local process: the
 * {@link OrgLocal} provide-list (KernelMemory, profile credentials,
 * REST polling, bun:sqlite, the local toolbox) under the shared HTTP
 * surface (Routes.ts), with the UI built by Vite and served from the
 * same address.
 *
 * Long-lived machinery (GitHub pollers, kernel run loops) registers on
 * {@link Local.Host} / the process Scope — so plain
 * `Effect.provide(OrgLocal)` is enough; the fibers survive init
 * returning. GitHub credentials resolve from the ALCHEMY PROFILE
 * (`alchemy login`); running additionally needs `ANTHROPIC_API_KEY`
 * in the operator's environment (the reconciler passes the shell env
 * through).
 */
import * as AI from "alchemy/AI";
import * as Local from "alchemy/Local";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { OrgLocal } from "./OrgLocal.ts";
import { orgRoutes } from "./Routes.ts";

export default class AlchemyOrg extends Local.Vite<AlchemyOrg>()(
  "AlchemyOrg",
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
    const gateway = yield* AI.AgentGateway;
    const api = yield* HttpRouter.toHttpEffect(yield* orgRoutes);

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
  }).pipe(Effect.provide(OrgLocal)),
) {}
