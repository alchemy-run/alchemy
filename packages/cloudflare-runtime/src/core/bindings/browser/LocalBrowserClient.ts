import * as LocalBrowser from "./Browser.ts";
import puppeteer, { type Page } from "@cloudflare/puppeteer";
import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import TurndownService from "turndown";
import { BrowserError, type BrowserClient } from "./BrowserClient.shared.ts";

const browserError = (cause: unknown) =>
  new BrowserError({
    message:
      cause instanceof Error ? cause.message : "Local browser action failed",
    cause,
  });

/** Node-side quick actions using the runtime's shared Chrome installer and launcher. */
export const makeLocalBrowserClient = (): BrowserClient => {
  const run = <A>(
    options: cf.BrowserRunCommonOptions,
    action: (page: Page, meta: cf.BrowserRunResponseMeta) => Promise<A>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const chrome = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => LocalBrowser.launchBrowser({}),
            catch: browserError,
          }),
          ({ browserProcess }) =>
            Effect.promise(() =>
              LocalBrowser.closeBrowserProcess(browserProcess),
            ),
        );
        const browser = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              puppeteer.connect({ browserWSEndpoint: chrome.wsEndpoint }),
            catch: browserError,
          }),
          (browser) => Effect.promise(() => browser.disconnect()),
        );
        return yield* Effect.tryPromise({
          try: async () => {
            if ("browser" in options && options.browser) {
              throw new Error(
                "Alternate browser backends require the hosted Browser Rendering service.",
              );
            }
            const page = await browser.newPage();
            page.setDefaultTimeout(options.actionTimeout ?? 30_000);
            await page.setViewport(
              options.viewport ?? { width: 1920, height: 1080 },
            );
            if (options.authenticate)
              await page.authenticate(options.authenticate);
            if (options.cookies) await page.setCookie(...options.cookies);
            if (options.userAgent) await page.setUserAgent(options.userAgent);
            if (options.setExtraHTTPHeaders)
              await page.setExtraHTTPHeaders(options.setExtraHTTPHeaders);
            if (options.setJavaScriptEnabled !== undefined)
              await page.setJavaScriptEnabled(options.setJavaScriptEnabled);
            if (options.emulateMediaType)
              await page.emulateMediaType(options.emulateMediaType);
            if (
              options.rejectRequestPattern ||
              options.allowRequestPattern ||
              options.rejectResourceTypes ||
              options.allowResourceTypes
            ) {
              const reject = options.rejectRequestPattern?.map(
                (p) => new RegExp(p),
              );
              const allow = options.allowRequestPattern?.map(
                (p) => new RegExp(p),
              );
              await page.setRequestInterception(true);
              page.on("request", (request) => {
                const type = request.resourceType();
                const blocked =
                  reject?.some((p) => p.test(request.url())) ||
                  (allow && !allow.some((p) => p.test(request.url()))) ||
                  options.rejectResourceTypes?.includes(type) ||
                  (options.allowResourceTypes &&
                    !options.allowResourceTypes.includes(type));
                void (blocked ? request.abort() : request.continue()).catch(
                  () => {},
                );
              });
            }
            const navigation = {
              waitUntil: "domcontentloaded" as const,
              ...options.gotoOptions,
            };
            const response =
              "url" in options
                ? await page.goto(options.url, navigation)
                : await page.setContent(options.html, navigation);
            for (const script of options.addScriptTag ?? [])
              await page.addScriptTag(script);
            for (const style of options.addStyleTag ?? [])
              await page.addStyleTag(style);
            if (options.waitForSelector) {
              const { selector, ...wait } = options.waitForSelector;
              await page.waitForSelector(selector, wait);
            }
            if (options.waitForTimeout)
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(options.waitForTimeout!, 120_000)),
              );
            return action(page, {
              status: response?.status() ?? 200,
              title: await page.title(),
              ...(response
                ? { headers: response.headers(), finalUrl: page.url() }
                : {}),
            });
          },
          catch: browserError,
        }).pipe(
          Effect.timeout("120 seconds"),
          Effect.mapError((cause) =>
            cause instanceof BrowserError ? cause : browserError(cause),
          ),
        );
      }),
    );
  const success = <A>(result: A, meta: cf.BrowserRunResponseMeta) => ({
    success: true as const,
    result,
    meta,
  });
  const markdown = async (page: Page) =>
    new TurndownService().turndown(await page.content());
  const screenshot = async (
    page: Page,
    options: cf.BrowserRunScreenshotOptions,
  ) => {
    if (options.scrollPage) {
      // This code executes in Chrome, whose DOM globals are deliberately
      // absent from the workerd/Node host's TypeScript environment.
      await page.evaluate(`(async () => {
        const height = document.body.scrollHeight;
        for (let y = 0; y < Math.min(height, window.innerHeight * 100); y += window.innerHeight) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        window.scrollTo(0, 0);
      })()`);
    }
    const target = options.selector
      ? await page.waitForSelector(options.selector)
      : page;
    if (!target) throw new Error(`No element matches ${options.selector}`);
    return target.screenshot({
      ...options.screenshotOptions,
      encoding: "binary",
    });
  };
  const binary = (effect: Effect.Effect<Uint8Array, BrowserError>) =>
    Stream.fromEffect(effect);
  const unsupported = (operation: string) =>
    Effect.fail(
      new BrowserError({
        message: `Local Browser ${operation} is unavailable. Use a Worker Browser binding for sessions, or the hosted Browser Rendering service for AI extraction.`,
        cause: new Error("unsupported"),
      }),
    );
  const client: BrowserClient = {
    raw: unsupported("raw").pipe(Effect.orDie),
    fetch: () => unsupported("fetch"),
    content: (options) =>
      run(options, async (page, meta) => success(await page.content(), meta)),
    markdown: (options) =>
      run(options, async (page, meta) => success(await markdown(page), meta)),
    links: (options) =>
      run(options, async (page, meta) =>
        success(
          await page.$$eval(
            "a[href]",
            (links, options) => [
              ...new Set(
                links
                  .filter(
                    (a) =>
                      (!options.visibleLinksOnly ||
                        a.getClientRects().length > 0) &&
                      (!options.excludeExternalLinks ||
                        new URL(a.href).origin === options.origin),
                  )
                  .map((a) => a.href),
              ),
            ],
            { ...options, origin: new URL(page.url()).origin },
          ),
          meta,
        ),
      ),
    scrape: (options) =>
      run(options, async (page, meta) =>
        success(
          await Promise.all(
            options.elements.map(async ({ selector }) => ({
              selector,
              results: await page.$$eval(selector, (elements) =>
                elements.map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    html: element.outerHTML,
                    text: element.textContent ?? "",
                    width: rect.width,
                    height: rect.height,
                    top: rect.top,
                    left: rect.left,
                    attributes: Array.from(
                      element.attributes,
                      ({ name, value }) => ({ name, value }),
                    ),
                  };
                }),
              ),
            })),
          ),
          meta,
        ),
      ),
    screenshot: (options) =>
      binary(run(options, (page) => screenshot(page, options))),
    pdf: (options) =>
      binary(run(options, (page) => page.pdf(options.pdfOptions))),
    snapshot: (options) =>
      run(options, async (page, meta) => {
        const formats = options.formats ?? ["content", "screenshot"];
        const result: cf.BrowserRunSnapshotSuccessResponse["result"] = {};
        if (formats.includes("content")) result.content = await page.content();
        if (formats.includes("markdown"))
          result.markdown = await markdown(page);
        if (formats.includes("screenshot"))
          result.screenshot = Buffer.from(
            await page.screenshot(options.screenshotOptions),
          ).toString("base64");
        if (formats.includes("accessibilityTree"))
          result.accessibilityTree =
            (await page.accessibility.snapshot()) ?? undefined;
        return success(result, meta);
      }),
    json: () => unsupported("AI JSON extraction"),
    quickAction: ((action, options) =>
      client[action](options as never)) as BrowserClient["quickAction"],
  };
  return client;
};
