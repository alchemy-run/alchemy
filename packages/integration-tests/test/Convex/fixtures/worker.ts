import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BindingDeployment } from "./resources.ts";

/** Answers with the tag of a typed failure, so a test can assert it. */
const tagged = <A, E extends { _tag: string; message?: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flatMap((value) => HttpServerResponse.json({ value })),
    Effect.catch((error: E) =>
      HttpServerResponse.json({ tag: error._tag, message: error.message }),
    ),
  );

export default class ConvexBindingWorker extends Cloudflare.Worker<ConvexBindingWorker>()(
  "ConvexBindingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const connect = yield* Convex.Connect(BindingDeployment);
    const query = yield* Convex.Query(BindingDeployment);
    const queryBatch = yield* Convex.QueryBatch(BindingDeployment);
    const mutation = yield* Convex.Mutation(BindingDeployment);
    const action = yield* Convex.Action(BindingDeployment);
    const usage = yield* Convex.GetCurrentUsage(BindingDeployment);
    const audit = yield* Convex.ListAuditLogEvents(BindingDeployment);
    const sync = yield* Convex.DataSync(BindingDeployment);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.url, "http://worker");
        switch (pathname) {
          case "/connect":
            return yield* tagged(Effect.all({ url: connect.url, siteUrl: connect.siteUrl }));
          case "/add":
            return yield* tagged(mutation("messages:add", { body: "from a worker" }));
          case "/list":
            return yield* tagged(query("messages:list"));
          case "/batch":
            return yield* tagged(queryBatch([{ path: "messages:list" }, { path: "hello:get" }]));
          case "/ping":
            return yield* tagged(action("messages:ping", { n: 41 }));
          case "/missing":
            return yield* tagged(query("messages:none"));
          case "/usage":
            return yield* tagged(usage());
          case "/audit":
            return yield* tagged(audit({ from: Date.now() - 3_600_000 }));
          case "/sync":
            return yield* tagged(sync.list());
          case "/export":
            return yield* tagged(sync.sync({}));
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Convex.ConnectHttp,
        Convex.QueryHttp,
        Convex.QueryBatchHttp,
        Convex.MutationHttp,
        Convex.ActionHttp,
        Convex.GetCurrentUsageHttp,
        Convex.ListAuditLogEventsHttp,
        Convex.DataSyncHttp,
      ),
    ),
  ),
) {}
