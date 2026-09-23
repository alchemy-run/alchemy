import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class BrowserError extends Data.TaggedError("BrowserError")<{
  message: string;
  cause: unknown;
}> {}

/** The `Response` type returned by the Cloudflare Browser Rendering binding. */
export type BrowserResponse = Awaited<ReturnType<cf.BrowserRun["fetch"]>>;

/** An Effect produced by a {@link BrowserClient} operation. */
type BrowserEffect<A, R> = Effect.Effect<A, BrowserError, R>;

/** A byte stream produced by a binary {@link BrowserClient} action. */
type BrowserByteStream<R> = Stream.Stream<Uint8Array, BrowserError, R>;

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
 * Mirrors the runtime {@link cf.BrowserRun} binding, translating its shapes into
 * Effect-native ones: JSON quick actions resolve to their parsed success
 * payload, and binary actions (`screenshot`, `pdf`) resolve to a `Stream` of the
 * response bytes. Non-success responses fail with {@link BrowserError}. The
 * {@link raw} accessor and {@link fetch} are the promise-shaped escape hatches
 * for libraries like `@cloudflare/puppeteer`.
 */
export interface BrowserClient<R = never> {
  /** Effect resolving to the raw Cloudflare Browser Rendering runtime binding. */
  raw: Effect.Effect<cf.BrowserRun, never, R>;
  /** Send a raw HTTP request to the Browser Run API. */
  fetch(
    ...args: Parameters<cf.BrowserRun["fetch"]>
  ): BrowserEffect<BrowserResponse, R>;
  /** Run a Browser Run quick action, resolving to the parsed payload. */
  quickAction(
    action: "screenshot",
    options: BrowserScreenshotOptions,
  ): BrowserByteStream<R>;
  quickAction(action: "pdf", options: BrowserPDFOptions): BrowserByteStream<R>;
  quickAction(
    action: "content",
    options: BrowserContentOptions,
  ): BrowserEffect<BrowserContentResult, R>;
  quickAction(
    action: "scrape",
    options: BrowserScrapeOptions,
  ): BrowserEffect<BrowserScrapeResult, R>;
  quickAction(
    action: "links",
    options: BrowserLinksOptions,
  ): BrowserEffect<BrowserLinksResult, R>;
  quickAction(
    action: "snapshot",
    options: BrowserSnapshotOptions,
  ): BrowserEffect<BrowserSnapshotResult, R>;
  quickAction(
    action: "json",
    options: BrowserJsonOptions,
  ): BrowserEffect<BrowserJsonResult, R>;
  quickAction(
    action: "markdown",
    options: BrowserMarkdownOptions,
  ): BrowserEffect<BrowserMarkdownResult, R>;
  /** Take a screenshot of a web page, streaming the raw image bytes. */
  screenshot(options: BrowserScreenshotOptions): BrowserByteStream<R>;
  /** Generate a PDF of a web page, streaming the raw PDF bytes. */
  pdf(options: BrowserPDFOptions): BrowserByteStream<R>;
  /** Get the HTML content of a web page. */
  content(
    options: BrowserContentOptions,
  ): BrowserEffect<BrowserContentResult, R>;
  /** Scrape elements from a web page by CSS selector. */
  scrape(options: BrowserScrapeOptions): BrowserEffect<BrowserScrapeResult, R>;
  /** Extract all links from a web page. */
  links(options: BrowserLinksOptions): BrowserEffect<BrowserLinksResult, R>;
  /** Get both the HTML content and a base64-encoded screenshot of a web page. */
  snapshot(
    options: BrowserSnapshotOptions,
  ): BrowserEffect<BrowserSnapshotResult, R>;
  /** Extract structured JSON data from a web page using AI. */
  json(options: BrowserJsonOptions): BrowserEffect<BrowserJsonResult, R>;
  /** Convert a web page to Markdown. */
  markdown(
    options: BrowserMarkdownOptions,
  ): BrowserEffect<BrowserMarkdownResult, R>;
}
