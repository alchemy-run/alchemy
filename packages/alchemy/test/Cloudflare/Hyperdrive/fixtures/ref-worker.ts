import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Name of the Hyperdrive config `Ref.test.ts` creates out-of-band (directly
 * via distilled, standing in for a dashboard-created config) before
 * deploying this fixture.
 */
export const REF_CONFIG_NAME = "alchemy-hyperdrive-ref-test";

/**
 * Read-only reference to the out-of-band config, addressed by name.
 */
export const RefByName = Cloudflare.Hyperdrive.Ref("HyperdriveRefByName", {
  name: REF_CONFIG_NAME,
});

/**
 * Worker binding the referenced config both ways: `env.HD` exercises the
 * env-binding classifier and `Connect` the Effect-native binding. `/meta`
 * reports the runtime binding's discrete fields (never secret material) so
 * the test can prove the binding resolves at runtime.
 */
export default class HyperdriveRefWorker extends Cloudflare.Worker<HyperdriveRefWorker>()(
  "HyperdriveRefWorker",
  {
    main: import.meta.url,
    env: { HD: RefByName },
  },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(RefByName);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/meta") {
          const host = yield* hd.host;
          const port = yield* hd.port;
          const database = yield* hd.database;
          return yield* HttpServerResponse.json({ host, port, database });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
