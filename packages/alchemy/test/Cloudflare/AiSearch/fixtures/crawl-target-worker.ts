import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const page = (title: string, body: string) =>
  HttpServerResponse.html(
    `<!doctype html><html><head><title>${title}</title></head>` +
      `<body>${body}</body></html>`,
  );

/**
 * A tiny Worker that serves a small crawlable site. Its `workers.dev` URL is a
 * domain the account owns, so it can seed an AI Search web-crawler instance
 * (which rejects domains the account hasn't verified).
 *
 * The instance uses `parseType: "crawl"` with `crawlOptions.source: "links"`
 * to walk pages by following links from the seed. We avoid the default
 * `sitemap` parse (and sitemap-based link discovery) because Cloudflare
 * validates the sitemap synchronously at create time and discovers it via
 * `robots.txt`, which a freshly-deployed `workers.dev` URL doesn't serve.
 */
export default class AiSearchCrawlTargetWorker extends Cloudflare.Worker<AiSearchCrawlTargetWorker>()(
  "AiSearchCrawlTargetWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `HttpServerRequest.url` is the request path (e.g. `/docs`), not an
        // absolute URL — `new URL(request.url)` would throw and 500. Match on
        // the path prefix directly.
        if (request.url.startsWith("/docs")) {
          return page(
            "Docs",
            "<h1>Alchemy docs</h1><p>Indexable documentation content.</p>",
          );
        }

        return page(
          "Crawl Target",
          "<h1>Alchemy AI Search crawl target</h1>" +
            "<p>This page exists so AI Search has something to index.</p>" +
            '<p><a href="/docs">Docs</a></p>',
        );
      }),
    };
  }),
) {}
