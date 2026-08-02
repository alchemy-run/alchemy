/**
 * The org, deployed — a Cloudflare Worker hosting the factory over the
 * {@link OrgWorker} provide-list: agent runs as Durable Objects, GitHub
 * by webhook + token bindings, D1 for the book of record, and the
 * coding tools on the sandbox container.
 *
 * The same HTTP surface as the local server (Routes.ts), plus the
 * substrate's own doors:
 *
 * - the GitHub webhook path is claimed by the event-source binding
 *   BEFORE this fetch handler (a `listen` registration);
 * - `/attach/:term/:key` upgrades a WebSocket into the run's own
 *   Durable Object — the run-socket live view (`useAgent`/`useChat`
 *   from `alchemy/AI/React` speak it directly).
 */
import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare/Workers";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { OrgWorker } from "./OrgWorker.ts";
import { orgRoutes } from "./Routes.ts";

export default class AlchemyOrgWorker extends Cloudflare.Worker<AlchemyOrgWorker>()(
  "AlchemyOrgWorker",
  {
    main: import.meta.url,
    // Same SPA Local.Vite serves locally (vite.config.ts → ui/dist).
    // Assets-first with SPA fallback for the UI; API / attach / webhook
    // paths run this Worker first so the SPA never swallows them.
    assets: {
      directory: "./ui/dist",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/attach/*", "/__alchemy/*"],
    },
  },
  Effect.gen(function* () {
    const gateway = yield* AI.AgentGateway;
    const api = yield* HttpRouter.toHttpEffect(yield* orgRoutes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://worker").pathname;
        // Keys may contain `/` (owner/repo#n) — rest-join after term,
        // matching the KernelCloudflare fixtures.
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
  }).pipe(Effect.provide(OrgWorker)),
) {}
