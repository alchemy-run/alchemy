import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { aliasRedirectUrl, parseAlias } from "./aliases.ts";

/**
 * Public alias hosts. The canonical 📦.alchemy.run is owned by the Api
 * worker and handles its own alias matching; this worker covers the other
 * three:
 *
 *   pkg.alchemy.run         → alchemy.run packages
 *   pkg.distilled.cloud     → distilled.cloud packages
 *   📦.distilled.cloud      → emoji alias for pkg.distilled.cloud
 *
 * All matches are 301 (permanent) so HTTP clients cache the redirect.
 */
export default class Redirect extends Cloudflare.Worker<Redirect>()(
  "Redirect",
  Stack.useSync(({ stage }) => ({
    main: import.meta.path,
    url: true,
    domain:
      stage === "prod"
        ? ["pkg.alchemy.run", "pkg.distilled.cloud", "📦.distilled.cloud"]
        : undefined,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  })),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const match = parseAlias(request.headers.host, url.pathname);

        if (!match) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }

        return HttpServerResponse.fromWeb(
          new Response(null, {
            status: 301,
            headers: { location: aliasRedirectUrl(match) },
          }),
        );
      }),
    };
  }),
) {}
