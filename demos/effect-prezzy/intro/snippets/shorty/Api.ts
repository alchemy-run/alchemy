import * as Cloudflare from "alchemy/Cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Links, LinksSql } from "./Links.ts";
import { ShortyApi } from "./ShortyApi.ts";
import { dieOnStore } from "./errors.ts";
import { D1Storage } from "./Storage.ts";

// #region show
// #region handlers
export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // #region body
    const links = yield* Links;

    const handlers = HttpApiBuilder.group(ShortyApi, "links", (h) =>
      h
        .handle("create", ({ payload }) => links.create(payload.url).pipe(Effect.orDie))
        .handle("get", ({ params }) => links.get(params.code).pipe(dieOnStore))
        .handle("list", () => links.list().pipe(Effect.orDie)),
    );
    // #endregion handlers

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(ShortyApi).pipe(
          Layer.provide(handlers),
          Layer.provide(Http.Platform),
          Layer.provide(HttpRouter.cors()),
        ),
      ),
    };
    // #endregion body
    // #region provide
  }).pipe(
    Effect.provide(LinksSql.pipe(Layer.provide(D1Storage))),
  ),
  // #endregion provide
);
// #endregion show
