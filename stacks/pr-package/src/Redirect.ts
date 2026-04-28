import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Legacy host redirector.
 *
 * Maps the old public hosts to the canonical 📦.alchemy.run API:
 *
 *   pkg.alchemy.run/:tag                → 📦.alchemy.run/projects/alchemy/tags/:tag
 *   pkg.distilled.cloud/:package/:tag   → 📦.alchemy.run/projects/distilled-:package/tags/:tag
 *
 * All redirects are 301 (permanent) so HTTP clients cache and follow them.
 */
const TARGET_HOST = "📦.alchemy.run";

export default class Redirect extends Cloudflare.Worker<Redirect>()(
  "Redirect",
  Stack.useSync(({ stage }) => ({
    main: import.meta.path,
    url: true,
    domain:
      stage === "prod" ? ["pkg.alchemy.run", "pkg.distilled.cloud"] : undefined,
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
        const host = (request.headers.host ?? "").toLowerCase();
        const segments = url.pathname.split("/").filter(Boolean);

        let location: string | undefined;

        if (host === "pkg.alchemy.run" && segments.length === 1) {
          const tag = segments[0]!;
          location = `https://${TARGET_HOST}/projects/alchemy/tags/${tag}`;
        } else if (host === "pkg.distilled.cloud" && segments.length === 2) {
          const [pkg, tag] = segments as [string, string];
          location = `https://${TARGET_HOST}/projects/distilled-${pkg}/tags/${tag}`;
        }

        if (!location) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }

        return HttpServerResponse.fromWeb(
          new Response(null, {
            status: 301,
            headers: { location },
          }),
        );
      }),
    };
  }),
) {}
