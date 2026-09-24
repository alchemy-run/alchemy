import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Links, LinksNeon } from "./links.ts";

// #region show
export default class Shorty extends Cloudflare.Worker<Shorty>()(
  "Shorty", { main: import.meta.url },
  Effect.gen(function* () {
    const links = yield* Links;
    return {
      fetch: Effect.gen(function* () {
        const { url } = yield* HttpServerRequest;
        const link = yield* links.get(url.slice(1));
        return HttpServerResponse.redirect(link.url);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(LinksNeon)),
) {}
// #endregion show
