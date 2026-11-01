import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const Blocked = Stackit.IPLists.IPList("IpListBindingsBlocked", {
  cidrs: ["198.51.100.0/24"],
  labels: { fixture: "ip-lists-bindings" },
});

/**
 * A Cloudflare Worker with every IP list binding. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the STACKIT error in the
 * test.
 */
export default class IPListsBindingsWorker extends Cloudflare.Worker<IPListsBindingsWorker>()(
  "StackitIpListsBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const blocked = yield* Blocked;
    const uploadIPList = yield* Stackit.IPLists.UploadIPList(blocked);
    const getIPList = yield* Stackit.IPLists.GetIPList(blocked);
    const listIPLists = yield* Stackit.IPLists.ListIPLists(blocked);
    const getQuota = yield* Stackit.IPLists.GetQuota(blocked);

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
          case "/upload-ip-list":
            return yield* respond(
              uploadIPList({ fileContent: param("cidrs").split(",").join("\n") }),
            );
          case "/get-ip-list":
            return yield* respond(getIPList());
          case "/list-ip-lists":
            return yield* respond(listIPLists());
          case "/get-quota":
            return yield* respond(getQuota());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.IPLists.UploadIPListHttp,
        Stackit.IPLists.GetIPListHttp,
        Stackit.IPLists.ListIPListsHttp,
        Stackit.IPLists.GetQuotaHttp,
      ),
    ),
  ),
) {}
