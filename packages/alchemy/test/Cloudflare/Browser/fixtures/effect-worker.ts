import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const TARGET_URL = "https://example.com";

const json = <T>(res: cf.Response) =>
  Effect.promise(() => res.json() as Promise<T>);

export default class BrowserEffectWorker extends Cloudflare.Worker<BrowserEffectWorker>()(
  "BrowserEffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const browser = yield* Cloudflare.Browser({
      name: "BROWSER",
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = request.url.split("?")[0];

        switch (path) {
          // Named wrappers over `quickAction`.
          case "/content": {
            const res = yield* browser
              .content({ url: TARGET_URL })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunContentSuccessResponse>(res);
            return yield* HttpServerResponse.json({
              title: body.meta.title,
              contentLength: body.result.length,
            });
          }
          case "/markdown": {
            const res = yield* browser
              .markdown({ url: TARGET_URL })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunMarkdownSuccessResponse>(res);
            return yield* HttpServerResponse.json({
              markdownLength: body.result.length,
            });
          }
          case "/links": {
            const res = yield* browser
              .links({ url: TARGET_URL })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunLinksSuccessResponse>(res);
            return yield* HttpServerResponse.json({
              linkCount: body.result.length,
            });
          }
          case "/scrape": {
            const res = yield* browser
              .scrape({ url: TARGET_URL, elements: [{ selector: "h1" }] })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunScrapeSuccessResponse>(res);
            return yield* HttpServerResponse.json({
              heading: body.result[0]?.results[0]?.text ?? null,
            });
          }
          case "/snapshot": {
            const res = yield* browser
              .snapshot({ url: TARGET_URL })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunSnapshotSuccessResponse>(res);
            return yield* HttpServerResponse.json({
              title: body.meta.title,
              screenshotLength: body.result.screenshot.length,
            });
          }
          case "/json": {
            const res = yield* browser
              .json({
                url: TARGET_URL,
                prompt: "Extract the page heading as { heading: string }",
              })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunJsonSuccessResponse>(res);
            return yield* HttpServerResponse.json({
              success: body.success,
            });
          }
          // Binary actions: surface response metadata instead of the body.
          case "/screenshot": {
            const res = yield* browser
              .screenshot({ url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              status: res.status,
              contentType: res.headers.get("content-type"),
            });
          }
          case "/pdf": {
            const res = yield* browser
              .pdf({ url: TARGET_URL })
              .pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              status: res.status,
              contentType: res.headers.get("content-type"),
            });
          }
          // Generic `quickAction` passthrough.
          case "/quickAction": {
            const res = yield* browser
              .quickAction("content", { url: TARGET_URL })
              .pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunContentSuccessResponse>(res);
            return yield* HttpServerResponse.json({ title: body.meta.title });
          }
          // `raw` exposes the underlying `cf.BrowserRun` binding (puppeteer, etc.).
          case "/raw": {
            const binding = yield* browser.raw;
            const res = yield* Effect.tryPromise(() =>
              binding.quickAction("content", { url: TARGET_URL }),
            ).pipe(Effect.orDie);
            const body = yield* json<cf.BrowserRunContentSuccessResponse>(res);
            return yield* HttpServerResponse.json({ title: body.meta.title });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(Effect.provide(Cloudflare.BrowserBindingLive)),
) {}
