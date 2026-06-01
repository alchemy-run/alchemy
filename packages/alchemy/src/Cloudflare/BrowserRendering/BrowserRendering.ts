import type * as Effect from "effect/Effect";
import { SingleShotGen } from "effect/Utils";
import {
  BrowserRenderingBinding,
  type BrowserRenderingClient,
} from "./BrowserRenderingBinding.ts";

type BrowserRenderingTypeId = typeof BrowserRenderingTypeId;
const BrowserRenderingTypeId = "Cloudflare.BrowserRendering" as const;

export type BrowserRenderingProps = {
  /**
   * Binding name used when `BrowserRendering` is bound from inside a Worker
   * init phase (`yield* Cloudflare.BrowserRendering(...)`). When passed through
   * `Worker({ env: { ... } })`, the object key remains the binding name.
   *
   * @default "BROWSER"
   */
  name?: string;
};

/**
 * The Effect yielded when a `BrowserRendering` marker is used inside a Worker
 * init phase: it attaches the `browser` binding to the surrounding Worker and
 * resolves to the runtime {@link BrowserRenderingClient}.
 */
type BindEffect = Effect.Effect<
  BrowserRenderingClient,
  never,
  BrowserRenderingBinding
>;

/**
 * Marker for a Cloudflare Browser Rendering binding.
 *
 * It is a plain data structure (so it can be declared directly on a Worker's
 * `env`) that is **also** yieldable inside an Effect-native Worker. Yielding it
 * (`yield* Cloudflare.BrowserRendering(...)`) attaches the binding to the
 * surrounding Worker and returns the runtime {@link BrowserRenderingClient} —
 * no separate `.bind(...)` step required.
 *
 * The divergence is achieved via `[Symbol.iterator]`: the object is not an
 * `Effect` (so `InferEnv` resolves it to the native `Fetcher` in the `env`
 * position), but it is iterable as one when `yield*`-ed.
 */
export interface BrowserRendering {
  kind: BrowserRenderingTypeId;
  name: string;
  asEffect(): BindEffect;
  [Symbol.iterator](): SingleShotGen<BindEffect, BrowserRenderingClient>;
}

export const isBrowserRendering = (value: unknown): value is BrowserRendering =>
  typeof value === "object" &&
  (value as BrowserRendering)?.kind === BrowserRenderingTypeId;

/**
 * A Cloudflare Browser Rendering binding for launching headless browser
 * sessions from Workers via `@cloudflare/puppeteer`.
 *
 * @binding
 *
 * @section Effect-style Worker (recommended)
 * @example Render a page title with managed browser cleanup
 * ```typescript
 * import puppeteer from "@cloudflare/puppeteer";
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "BrowserWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns the runtime client.
 *     const browserRendering = yield* Cloudflare.BrowserRendering({
 *       name: "BROWSER",
 *     });
 *
 *     return {
 *       fetch: browserRendering.withBrowser(puppeteer, (browser) =>
 *         Effect.gen(function* () {
 *           const page = yield* Effect.tryPromise(() => browser.newPage());
 *           yield* Effect.tryPromise(() => page.goto("https://example.com"));
 *           const title = yield* Effect.tryPromise(() => page.title());
 *           return Response.json({ title });
 *         }),
 *       ),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.BrowserRenderingBindingLive)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: {
 *     BROWSER: Cloudflare.BrowserRendering(),
 *   },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { BROWSER: Fetcher }
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
export const BrowserRendering: {
  (props?: BrowserRenderingProps): BrowserRendering;
  /**
   * Bind an existing `BrowserRendering` marker to the surrounding Worker,
   * returning the runtime client. Equivalent to `yield* browser` — prefer
   * yielding the marker directly.
   */
  bind: typeof BrowserRenderingBinding.bind;
} = Object.assign(
  (props?: BrowserRenderingProps): BrowserRendering => {
    const self: BrowserRendering = {
      kind: BrowserRenderingTypeId,
      name: props?.name ?? "BROWSER",
      asEffect: () => BrowserRenderingBinding.bind(self),
      [Symbol.iterator]: () =>
        new SingleShotGen(BrowserRenderingBinding.bind(self)),
    };
    return self;
  },
  {
    bind: (...args: Parameters<typeof BrowserRenderingBinding.bind>) =>
      BrowserRenderingBinding.bind(...args),
  },
);
