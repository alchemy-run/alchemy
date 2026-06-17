import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * A tiny Worker that serves a crawlable HTML page. Its `workers.dev` URL is a
 * domain the account owns, so it can be used as a seed for an AI Search
 * web-crawler instance (which rejects domains the account hasn't verified).
 */
export default class AiSearchCrawlTargetWorker extends Cloudflare.Worker<AiSearchCrawlTargetWorker>()(
  "AiSearchCrawlTargetWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.html(
          "<!doctype html><html><head><title>Crawl Target</title></head>" +
            "<body><h1>Alchemy AI Search crawl target</h1>" +
            "<p>This page exists so AI Search has something to index.</p>" +
            "</body></html>",
        );
      }),
    };
  }),
) {}
