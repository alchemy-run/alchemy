import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Ping } from "./stack.ts";

/**
 * A Cloudflare Worker with every Functions binding. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the STACKIT error.
 */
export default class FunctionsBindingsWorker extends Cloudflare.Worker<FunctionsBindingsWorker>()(
  "StackitFunctionsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const ping = yield* Ping;
    const getFunction = yield* Stackit.Functions.GetFunction(ping);
    const listFunctions = yield* Stackit.Functions.ListFunctions(ping);
    const getRevision = yield* Stackit.Functions.GetRevision(ping);
    const listRevisions = yield* Stackit.Functions.ListRevisions(ping);
    const invoke = yield* Stackit.Functions.Invoke(ping);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-function":
            return yield* respond(getFunction());
          case "/list-functions":
            return yield* respond(listFunctions());
          case "/get-revision":
            return yield* respond(
              // A variable's value must not leave the Worker in the test's logs.
              getRevision({ revisionId: param("id") }).pipe(
                Effect.map(({ id, state, oci_reference }) => ({ id, state, oci_reference })),
              ),
            );
          case "/list-revisions":
            return yield* respond(
              listRevisions().pipe(
                Effect.map((listed) => ({
                  ids: (listed.revisionList ?? []).map((revision) => revision.id),
                })),
              ),
            );
          case "/invoke":
            return yield* respond(
              invoke({ path: param("path") }).pipe(Effect.flatMap((response) => response.json)),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Functions.GetFunctionHttp,
        Stackit.Functions.ListFunctionsHttp,
        Stackit.Functions.GetRevisionHttp,
        Stackit.Functions.ListRevisionsHttp,
        Stackit.Functions.InvokeHttp,
      ),
    ),
  ),
) {}
