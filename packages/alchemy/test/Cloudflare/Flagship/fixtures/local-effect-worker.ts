import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { App } from "./local-app.ts";
export default class LocalFlagshipWorker extends Cloudflare.Worker<LocalFlagshipWorker>()(
  "OfflineFlagsEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const flags = yield* Cloudflare.Flagship.ReadFlags(App);
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(
          yield* flags
            .getBooleanDetails("enabled", false, { plan: "enterprise" })
            .pipe(Effect.orDie),
        );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsBinding)),
) {}
