import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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

/** An Effect produced by a {@link BrowserClient} operation. */
type BrowserEffect<A> = Effect.Effect<A, BrowserError, RuntimeContext>;

/** A byte stream produced by a binary {@link BrowserClient} action. */
type BrowserByteStream = Stream.Stream<
  Uint8Array,
  BrowserError,
  RuntimeContext
>;

// Quick action option types, re-exported so callers don't reach into the
// `@cloudflare/workers-types` namespace directly.
export type BrowserScreenshotOptions = cf.BrowserRunScreenshotOptions;
export type BrowserPDFOptions = cf.BrowserRunPDFOptions;
export type BrowserContentOptions = cf.BrowserRunContentOptions;
export type BrowserScrapeOptions = cf.BrowserRunScrapeOptions;
export type BrowserLinksOptions = cf.BrowserRunLinksOptions;
export type BrowserSnapshotOptions = cf.BrowserRunSnapshotOptions;
export type BrowserJsonOptions = cf.BrowserRunJsonOptions;
export type BrowserMarkdownOptions = cf.BrowserRunMarkdownOptions;

// Quick action success payloads.
export type BrowserContentResult = cf.BrowserRunContentSuccessResponse;
export type BrowserScrapeResult = cf.BrowserRunScrapeSuccessResponse;
export type BrowserLinksResult = cf.BrowserRunLinksSuccessResponse;
export type BrowserSnapshotResult = cf.BrowserRunSnapshotSuccessResponse;
export type BrowserJsonResult = cf.BrowserRunJsonSuccessResponse;
export type BrowserMarkdownResult = cf.BrowserRunMarkdownSuccessResponse;
export type BrowserErrorResponse = cf.BrowserRunErrorResponse;

/**
 * Effect-native client for a Cloudflare Browser Rendering binding.
 *
 * Mirrors the runtime {@link cf.BrowserRun} binding, translating its shapes
 * into Effect-native ones: JSON quick actions resolve to their parsed success
 * payload, and binary actions (`screenshot`, `pdf`) resolve to a `Stream` of
 * the response bytes. Non-success responses fail with {@link BrowserError}, so
 * callers never touch a `Promise` or `Response.json()` themselves. Use
 * `Cloudflare.Browser.bind(browser)` (or `yield* Cloudflare.Browser(...)`)
 * inside a Worker's init phase to obtain it.
 *
 * The {@link raw} accessor and {@link fetch} are the only promise-shaped
 * escape hatches — they exist for libraries like `@cloudflare/puppeteer` that
 * consume the binding directly.
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
   * Send a raw HTTP request to the Browser Run API and resolve to the raw
   * `Response`. Used by libraries like `@cloudflare/puppeteer` to acquire and
   * connect to a browser instance.
   */
  fetch(
    ...args: Parameters<cf.BrowserRun["fetch"]>
  ): BrowserEffect<BrowserResponse>;
  /**
   * Run a Browser Run quick action, resolving to the parsed success payload
   * (or a byte `Stream` for binary actions). Mirrors
   * `cf.BrowserRun["quickAction"]`; the {@link screenshot}, {@link pdf},
   * {@link content}, {@link scrape}, {@link links}, {@link snapshot},
   * {@link json}, and {@link markdown} methods are thin wrappers over the
   * corresponding action.
   */
  quickAction(
    action: "screenshot",
    options: BrowserScreenshotOptions,
  ): BrowserByteStream;
  quickAction(action: "pdf", options: BrowserPDFOptions): BrowserByteStream;
  quickAction(
    action: "content",
    options: BrowserContentOptions,
  ): BrowserEffect<BrowserContentResult>;
  quickAction(
    action: "scrape",
    options: BrowserScrapeOptions,
  ): BrowserEffect<BrowserScrapeResult>;
  quickAction(
    action: "links",
    options: BrowserLinksOptions,
  ): BrowserEffect<BrowserLinksResult>;
  quickAction(
    action: "snapshot",
    options: BrowserSnapshotOptions,
  ): BrowserEffect<BrowserSnapshotResult>;
  quickAction(
    action: "json",
    options: BrowserJsonOptions,
  ): BrowserEffect<BrowserJsonResult>;
  quickAction(
    action: "markdown",
    options: BrowserMarkdownOptions,
  ): BrowserEffect<BrowserMarkdownResult>;
  /**
   * Take a screenshot of a web page, streaming the raw image bytes.
   */
  screenshot(options: BrowserScreenshotOptions): BrowserByteStream;
  /**
   * Generate a PDF of a web page, streaming the raw PDF bytes.
   */
  pdf(options: BrowserPDFOptions): BrowserByteStream;
  /**
   * Get the HTML content of a web page.
   */
  content(options: BrowserContentOptions): BrowserEffect<BrowserContentResult>;
  /**
   * Scrape elements from a web page by CSS selector.
   */
  scrape(options: BrowserScrapeOptions): BrowserEffect<BrowserScrapeResult>;
  /**
   * Extract all links from a web page.
   */
  links(options: BrowserLinksOptions): BrowserEffect<BrowserLinksResult>;
  /**
   * Get both the HTML content and a base64-encoded screenshot of a web page.
   */
  snapshot(
    options: BrowserSnapshotOptions,
  ): BrowserEffect<BrowserSnapshotResult>;
  /**
   * Extract structured JSON data from a web page using AI.
   */
  json(options: BrowserJsonOptions): BrowserEffect<BrowserJsonResult>;
  /**
   * Convert a web page to Markdown.
   */
  markdown(
    options: BrowserMarkdownOptions,
  ): BrowserEffect<BrowserMarkdownResult>;
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

/** Actions whose successful response is raw binary rather than JSON. */
const BINARY_ACTIONS = new Set(["screenshot", "pdf"]);

/** Build a {@link BrowserError} from a non-success Browser Run response. */
const failResponse = (
  action: string,
  response: BrowserResponse,
): Effect.Effect<never, BrowserError> =>
  tryPromise(() => response.text()).pipe(
    Effect.flatMap((body) => {
      let cause: unknown = body;
      try {
        cause = JSON.parse(body);
      } catch {
        // keep the raw text as the cause
      }
      const message =
        (cause as cf.BrowserRunErrorResponse | undefined)?.errors?.[0]
          ?.message ??
        `Browser Rendering '${action}' failed with status ${response.status}`;
      return Effect.fail(new BrowserError({ message, cause }));
    }),
  );

/** @internal */
export const makeBrowserClient = (
  raw: Effect.Effect<cf.BrowserRun, never, RuntimeContext>,
): BrowserClient => {
  const respond = (
    action: string,
    options: unknown,
  ): Effect.Effect<BrowserResponse, BrowserError, RuntimeContext> =>
    raw.pipe(
      Effect.flatMap((binding) =>
        tryPromise(() => binding.quickAction(action as any, options as any)),
      ),
      Effect.flatMap((response) =>
        response.ok ? Effect.succeed(response) : failResponse(action, response),
      ),
    );

  const jsonAction = <T>(action: string, options: unknown): BrowserEffect<T> =>
    respond(action, options).pipe(
      Effect.flatMap((response) =>
        tryPromise(() => response.json() as Promise<T>),
      ),
    );

  const streamAction = (action: string, options: unknown): BrowserByteStream =>
    respond(action, options).pipe(
      Effect.map((response) =>
        Stream.fromReadableStream({
          evaluate: () =>
            response.body as any as ReadableStream<Uint8Array<ArrayBufferLike>>,
          onError: (cause) =>
            new BrowserError({
              message: `Browser Rendering '${action}' stream failed`,
              cause,
            }),
        }),
      ),
      Stream.unwrap,
    );

  const quickAction = ((action: string, options: unknown) =>
    BINARY_ACTIONS.has(action)
      ? streamAction(action, options)
      : jsonAction(action, options)) as BrowserClient["quickAction"];

  return {
    raw,
    fetch: (...args) =>
      raw.pipe(
        Effect.flatMap((binding) => tryPromise(() => binding.fetch(...args))),
      ),
    quickAction,
    screenshot: (options) => streamAction("screenshot", options),
    pdf: (options) => streamAction("pdf", options),
    content: (options) => jsonAction("content", options),
    scrape: (options) => jsonAction("scrape", options),
    links: (options) => jsonAction("links", options),
    snapshot: (options) => jsonAction("snapshot", options),
    json: (options) => jsonAction("json", options),
    markdown: (options) => jsonAction("markdown", options),
  } satisfies BrowserClient;
};
