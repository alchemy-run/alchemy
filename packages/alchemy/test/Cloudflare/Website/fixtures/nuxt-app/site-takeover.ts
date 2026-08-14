import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The stand-down twin of `site.ts`: `server: { takeover: false }` opts out
 * of automatic delivery, so the dev server must NOT inject the effect
 * middleware — with no explicit `alchemy/Nitro` mount in `server/`, the
 * claimed routes fall back to nitro (its own 404), and the rpc path is
 * never claimed. Pins the CF dev half of the explicit-tier stand-down.
 */
export default class NuxtTakeoverSite extends Cloudflare.Website.Nuxt<NuxtTakeoverSite>()(
  "NuxtTakeoverSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    server: { routes: ["/api/*", "!/api/hello"], takeover: false },
    dev: { port: 0 },
    memo: {
      include: [
        "app/**",
        "server/**",
        "public/**",
        "nuxt.config.ts",
        "site-takeover.ts",
        "package.json",
      ],
    },
  },
  Effect.gen(function* () {
    return {
      greet: (name: string) => Effect.succeed(`hello ${name}`),
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ marker: "must-not-serve" });
      }),
    };
  }),
) {}
