import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import { BrowserBinding, type BrowserClient } from "./BrowserBinding.ts";

type BrowserTypeId = typeof BrowserTypeId;
const BrowserTypeId = "Cloudflare.Browser" as const;

export type BrowserProps = {
  /**
   * Binding name used when `Browser` is bound from inside a Worker init phase
   * (`yield* Cloudflare.Browser(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "BROWSER"
   */
  name?: string;
};

/**
 * The Effect yielded when a `Browser` marker is used inside a Worker init
 * phase: it attaches the `browser` binding to the surrounding Worker and
 * resolves to the runtime {@link BrowserClient}.
 */
type BindEffect = Effect.Effect<BrowserClient, never, BrowserBinding>;

/**
 * Marker for a Cloudflare Browser Rendering binding.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.Browser(...)`) attaches the binding to the surrounding
 * Worker and returns the runtime {@link BrowserClient} — no separate
 * `.bind(...)` step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is
 * deliberately not an `Effect` (so `InferEnv` and the Worker `env` resolver
 * keep it as the native `BrowserRun` rather than `yield*`-ing it), but it is
 * iterable as one when `yield*`-ed.
 */
export interface Browser {
  kind: BrowserTypeId;
  name: string;
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, BrowserClient>;
}

export const isBrowser = (value: unknown): value is Browser =>
  typeof value === "object" && (value as Browser)?.kind === BrowserTypeId;

/**
 * A Cloudflare Browser Rendering binding for launching headless browser
 * sessions from Workers via `@cloudflare/puppeteer`.
 *
 * @binding
 * @product Browser Rendering
 * @category Developer Platform
 *
 * @section Effect-style Worker (recommended)
 * @example Bind the runtime client and convert a page to Markdown
 * Yielding the marker attaches the binding to the surrounding Worker and
 * returns the runtime {@link BrowserClient}. Every `cf.BrowserRun` method is
 * mirrored as an Effect, so no `Effect.tryPromise` wrapping is needed.
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "BrowserWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser({ name: "BROWSER" });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* browser.markdown({ url: "https://example.com" });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.BrowserBindingLive)),
 * );
 * ```
 *
 * @section Quick Actions
 * @example Render content, screenshot, PDF, and structured data
 * JSON quick actions resolve to their parsed payload; binary actions
 * (`screenshot`, `pdf`) resolve to a `Stream` of bytes. No `Promise` or
 * `Response.json()` in sight.
 * ```typescript
 * import * as Effect from "effect/Effect";
 * import * as Stream from "effect/Stream";
 *
 * const browser = yield* Cloudflare.Browser({ name: "BROWSER" });
 * const url = "https://example.com";
 *
 * // HTML content — parsed payload, title lives in `meta`.
 * const content = yield* browser.content({ url });
 * const title = content.meta.title;
 *
 * // Scrape elements by CSS selector.
 * yield* browser.scrape({ url, elements: [{ selector: "h1" }] });
 *
 * // Extract all links.
 * const { result: links } = yield* browser.links({ url });
 *
 * // Binary actions stream bytes — collect or pipe them.
 * const png = yield* browser.screenshot({ url }).pipe(Stream.runCollect);
 * const pdf = yield* browser.pdf({ url }).pipe(Stream.runCollect);
 *
 * // AI-extracted structured data.
 * yield* browser.json({ url, prompt: "Extract the page heading" });
 * ```
 *
 * @example Call the generic `quickAction` directly
 * The named methods are thin wrappers over `quickAction`, which mirrors
 * `cf.BrowserRun["quickAction"]` one-to-one.
 * ```typescript
 * const browser = yield* Cloudflare.Browser({ name: "BROWSER" });
 *
 * const res = yield* browser.quickAction("snapshot", {
 *   url: "https://example.com",
 * });
 * ```
 *
 * @section Driving Puppeteer
 * @example Use the raw `cf.BrowserRun` binding with `@cloudflare/puppeteer`
 * `raw` hands you the underlying runtime binding. Puppeteer is promise-based,
 * so this is the one place you reach for `Effect.tryPromise`.
 * ```typescript
 * import puppeteer from "@cloudflare/puppeteer";
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "BrowserWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser({ name: "BROWSER" });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const binding = yield* browser.raw;
 *         const session = yield* Effect.tryPromise(() =>
 *           puppeteer.launch(binding),
 *         );
 *         try {
 *           const page = yield* Effect.tryPromise(() => session.newPage());
 *           yield* Effect.tryPromise(() => page.goto("https://example.com"));
 *           const title = yield* Effect.tryPromise(() => page.title());
 *           return Response.json({ title });
 *         } finally {
 *           yield* Effect.promise(() => session.close());
 *         }
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.BrowserBindingLive)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example Declare the binding on `env`
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     BROWSER: Cloudflare.Browser(),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { BROWSER: BrowserRun }
 * ```
 *
 * @example Async-style worker with the raw runtime binding
 * ```typescript
 * import puppeteer from "@cloudflare/puppeteer";
 * import type { WorkerEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const browser = await puppeteer.launch(env.BROWSER);
 *     const page = await browser.newPage();
 *     await page.goto("https://example.com");
 *     const screenshot = await page.screenshot();
 *     await browser.close();
 *
 *     return new Response(screenshot, {
 *       headers: { "content-type": "image/png" },
 *     });
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/browser-rendering/workers-binding-api/
 */
export const Browser: {
  (props?: BrowserProps): Browser;
  /**
   * Bind an existing `Browser` marker to the surrounding Worker, returning the
   * runtime client. Equivalent to `yield* browser` — prefer yielding the marker
   * directly.
   */
  bind: typeof BrowserBinding.bind;
} = Object.assign(
  (props?: BrowserProps): Browser => {
    const self: Browser = {
      kind: BrowserTypeId,
      name: props?.name ?? "BROWSER",
      asEffect: () => BrowserBinding.bind(self),
      [Symbol.iterator]: () => new SingleShotGen(BrowserBinding.bind(self)),
    };
    return self;
  },
  {
    bind: (...args: Parameters<typeof BrowserBinding.bind>) =>
      BrowserBinding.bind(...args),
  },
);
