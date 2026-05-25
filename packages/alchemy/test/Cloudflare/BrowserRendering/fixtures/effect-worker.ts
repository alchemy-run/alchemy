import puppeteer from "@cloudflare/puppeteer";
import * as Cloudflare from "alchemy/Cloudflare";
import type { BrowserRenderingPuppeteer } from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const TARGET_URL = "https://example.com";

type PuppeteerBrowser = Awaited<ReturnType<(typeof puppeteer)["launch"]>>;

const cloudflarePuppeteer =
  puppeteer as unknown as BrowserRenderingPuppeteer<PuppeteerBrowser>;

export const Browser = Cloudflare.BrowserRendering({ name: "BROWSER" });

export default class BrowserRenderingEffectWorker extends Cloudflare.Worker<BrowserRenderingEffectWorker>()(
  "BrowserRenderingEffectWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const browserRendering = yield* Cloudflare.BrowserRendering.bind(
      yield* Browser,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (!request.url.startsWith("/title")) {
          return HttpServerResponse.text("ok");
        }

        return yield* browserRendering
          .withBrowser(cloudflarePuppeteer, (browser) =>
            Effect.gen(function* () {
              const page = yield* Effect.tryPromise(() => browser.newPage());
              yield* Effect.tryPromise(() =>
                page.goto(TARGET_URL, { waitUntil: "networkidle0" }),
              );
              const title = yield* Effect.tryPromise(() => page.title());
              return { title };
            }),
          )
          .pipe(
            Effect.orDie,
            Effect.flatMap(({ title }) =>
              HttpServerResponse.json({ mode: "effect", title }),
            ),
          );
      }),
    };
  }).pipe(Effect.provide(Cloudflare.BrowserRenderingBindingLive)),
) {}
