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
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import { OrgWorker } from "./OrgWorker.ts";
import { orgRoutes } from "./Routes.ts";

export default class AlchemyOrgWorker extends Cloudflare.Worker<AlchemyOrgWorker>()(
  "AlchemyOrgWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const gateway = yield* AI.AgentGateway;
    const routes = yield* orgRoutes;

    // the run socket: the live, durable per-run view — replay from a
    // cursor plus live tail, straight from the run's Durable Object
    const attach = HttpRouter.add(
      "GET",
      "/attach/:term/:key",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const params = yield* HttpRouter.params;
        return yield* gateway.attach(
          String(params.term ?? ""),
          decodeURIComponent(String(params.key ?? "")),
          request,
        );
      }),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(Layer.mergeAll(routes, attach)),
    };
  }).pipe(Effect.provide(OrgWorker)),
) {}
