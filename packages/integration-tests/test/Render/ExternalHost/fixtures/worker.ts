import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Render from "@alchemy.run/render";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const ExternalCache = Render.KeyValue("RenderExternalHostKv", {
  plan: "starter",
  region: "oregon",
  ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "cf-worker-external-host" }],
});

/**
 * Foreign host (Cloudflare Worker) binding a Render KeyValue store via
 * `Render.ReadWriteKeyValue`.
 */
export default class ExternalHostWorker extends Cloudflare.Worker<ExternalHostWorker>()(
  "RenderExternalHostWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const kvResource = yield* ExternalCache;
    const kv = yield* Render.ReadWriteKeyValue(kvResource);

    return {
      fetch: Effect.gen(function* () {
        const req = yield* HttpServerRequest;
        const url = new URL(req.url, "http://worker");
        if (url.pathname === "/kv") {
          return yield* Effect.gen(function* () {
            yield* kv.set("alchemy:external-host", "from-cf-worker");
            const value = yield* kv.get("alchemy:external-host");
            return yield* HttpServerResponse.json({ ok: true, value });
          }).pipe(
            Effect.catchCause((cause) =>
              HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
            ),
          );
        }
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }).pipe(Effect.provide(Render.ReadWriteKeyValueHttp)),
) {}
