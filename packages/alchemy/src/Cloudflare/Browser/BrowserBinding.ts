import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Browser as BrowserLike } from "./Browser.ts";

export class BrowserError extends Data.TaggedError("BrowserError")<{
  message: string;
  cause: unknown;
}> {}

/** The `Response` type returned by the Cloudflare Browser Rendering binding. */
type BrowserResponse = Awaited<ReturnType<cf.BrowserRun["fetch"]>>;

/**
 * Effect-native client for a Cloudflare Browser Rendering binding.
 *
 * Mirrors the runtime {@link cf.BrowserRun} binding one-to-one, wrapping every
 * method so it returns an Effect tagged with {@link BrowserError}. Use
 * `Cloudflare.Browser.bind(browser)` (or `yield* Cloudflare.Browser(...)`)
 * inside a Worker's init phase to obtain it.
 *
 * The {@link raw} accessor exposes the underlying `BrowserRun` binding for
 * libraries that consume it directly, such as `@cloudflare/puppeteer`.
 */
export interface BrowserClient {
  /**
   * Effect resolving to the raw Cloudflare Browser Rendering runtime binding.
   *
   * Pass it to `@cloudflare/puppeteer`'s `puppeteer.launch(binding)` to drive a
   * full browser session.
   */
  raw: Effect.Effect<cf.BrowserRun, never, RuntimeContext>;
  /**
   * Send a raw HTTP request to the Browser Run API. Used by libraries like
   * `@cloudflare/puppeteer` to acquire and connect to a browser instance.
   */
  fetch(
    ...args: Parameters<cf.BrowserRun["fetch"]>
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Run a Browser Run quick action. Mirrors `cf.BrowserRun["quickAction"]`;
   * the {@link screenshot}, {@link pdf}, {@link content}, {@link scrape},
   * {@link links}, {@link snapshot}, {@link json}, and {@link markdown}
   * methods are thin wrappers over the corresponding action.
   */
  quickAction(
    action: "screenshot",
    options: cf.BrowserRunScreenshotOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "pdf",
    options: cf.BrowserRunPDFOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "content",
    options: cf.BrowserRunContentOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "scrape",
    options: cf.BrowserRunScrapeOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "links",
    options: cf.BrowserRunLinksOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "snapshot",
    options: cf.BrowserRunSnapshotOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "json",
    options: cf.BrowserRunJsonOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  quickAction(
    action: "markdown",
    options: cf.BrowserRunMarkdownOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Take a screenshot of a web page.
   */
  screenshot(
    options: cf.BrowserRunScreenshotOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Generate a PDF of a web page.
   */
  pdf(
    options: cf.BrowserRunPDFOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Get the HTML content of a web page.
   */
  content(
    options: cf.BrowserRunContentOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Scrape elements from a web page by CSS selector.
   */
  scrape(
    options: cf.BrowserRunScrapeOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Extract all links from a web page.
   */
  links(
    options: cf.BrowserRunLinksOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Get both the HTML content and a base64-encoded screenshot of a web page.
   */
  snapshot(
    options: cf.BrowserRunSnapshotOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Extract structured JSON data from a web page using AI.
   */
  json(
    options: cf.BrowserRunJsonOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
  /**
   * Convert a web page to Markdown.
   */
  markdown(
    options: cf.BrowserRunMarkdownOptions,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext>;
}

export class BrowserBinding extends Binding.Service<
  BrowserBinding,
  (browser: BrowserLike) => Effect.Effect<BrowserClient>
>()("Cloudflare.Browser.Binding") {}

export const BrowserBindingLive = Layer.effect(
  BrowserBinding,
  Effect.gen(function* () {
    const Policy = yield* BrowserBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (browser: BrowserLike) {
      yield* Policy(browser);
      const raw: Effect.Effect<cf.BrowserRun, never, RuntimeContext> =
        Effect.sync(
          () => (env as Record<string, cf.BrowserRun>)[browser.name]!,
        );
      return makeBrowserClient(raw);
    });
  }),
);

export class BrowserBindingPolicy extends Binding.Policy<
  BrowserBindingPolicy,
  (browser: BrowserLike) => Effect.Effect<void>
>()("Cloudflare.Browser.Binding") {}

export const BrowserBindingPolicyLive = BrowserBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, browser: BrowserLike) {
    if (isWorker(host)) {
      yield* host.bind(browser.name, {
        bindings: [
          {
            type: "browser",
            name: browser.name,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`BrowserBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, BrowserError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new BrowserError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown Browser Rendering error",
        cause: error,
      }),
  });

/** @internal */
export const makeBrowserClient = (
  raw: Effect.Effect<cf.BrowserRun, never, RuntimeContext>,
): BrowserClient => {
  const use = (
    fn: (binding: cf.BrowserRun) => Promise<BrowserResponse>,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext> =>
    raw.pipe(Effect.flatMap((binding) => tryPromise(() => fn(binding))));

  const quickAction = ((action: any, options: any) =>
    use((binding) =>
      binding.quickAction(action, options),
    )) as BrowserClient["quickAction"];

  return {
    raw,
    fetch: (...args) => use((binding) => binding.fetch(...args)),
    quickAction,
    screenshot: (options) => quickAction("screenshot", options),
    pdf: (options) => quickAction("pdf", options),
    content: (options) => quickAction("content", options),
    scrape: (options) => quickAction("scrape", options),
    links: (options) => quickAction("links", options),
    snapshot: (options) => quickAction("snapshot", options),
    json: (options) => quickAction("json", options),
    markdown: (options) => quickAction("markdown", options),
  } satisfies BrowserClient;
};
