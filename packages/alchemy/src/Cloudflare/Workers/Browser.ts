import type { BrowserClient as RuntimeBrowserClient } from "@alchemy.run/cloudflare-runtime/core/bindings/browser/BrowserClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";

export { BrowserError } from "@alchemy.run/cloudflare-runtime/core/bindings/browser/BrowserClient";
export type {
  BrowserResponse,
  BrowserScreenshotOptions,
  BrowserPDFOptions,
  BrowserContentOptions,
  BrowserScrapeOptions,
  BrowserLinksOptions,
  BrowserSnapshotOptions,
  BrowserJsonOptions,
  BrowserMarkdownOptions,
  BrowserContentResult,
  BrowserScrapeResult,
  BrowserLinksResult,
  BrowserSnapshotResult,
  BrowserJsonResult,
  BrowserMarkdownResult,
  BrowserErrorResponse,
} from "@alchemy.run/cloudflare-runtime/core/bindings/browser/BrowserClient";
export type BrowserClient = RuntimeBrowserClient<RuntimeContext>;

const TypeId = "Cloudflare.Browser" as const;
type TypeId = typeof TypeId;

/**
 * A Cloudflare Browser Rendering binding for launching headless browser sessions
 * from Workers — a Worker-only binding with no backing cloud resource.
 *
 * `Browser` is a single value that is at once the `Binding.Service` tag, the
 * callable that produces a {@link BrowserBinding}, and the type. Declare it on a
 * Worker's `env` (it flows through `InferEnv` → `cf.BrowserRun`) or `yield*` it
 * inside an Effect-native Worker to attach the binding and obtain the
 * {@link BrowserClient}.
 *
 * ### Effect-style Worker (recommended)
 * **Example:** Bind the runtime client and convert a page to Markdown
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "BrowserWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser("BROWSER");
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* browser.markdown({ url: "https://example.com" });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
 * );
 * ```
 *
 * ### Worker binding metadata
 * **Example:** Declare the binding on `env`
 * ```typescript
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { BROWSER: Cloudflare.Browser() },
 * });
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 * //   { BROWSER: BrowserRun }
 * ```
 *
 * ### Local development
 * **Example:** Proxy to the real Browser Rendering service in dev
 * ```typescript
 * // Default: a real headless Chrome is launched locally and driven over
 * // CDP under `alchemy dev`. Alchemy.remote() opts the binding into the
 * // real Browser Rendering service instead — in an Effect-native Worker:
 * const browser = yield* Cloudflare.Browser("BROWSER").pipe(Alchemy.remote());
 *
 * // or declared on an async Worker's env:
 * env: { BROWSER: Cloudflare.Browser("BROWSER").pipe(Alchemy.remote()) }
 * ```
 *
 * @see https://developers.cloudflare.com/browser-rendering/workers-binding-api/
 *
 * @binding
 * @product Browser Rendering
 * @category Developer Platform
 */
export interface Browser extends Binding.Service<
  Browser,
  TypeId,
  BrowserClient
> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   * @default "BROWSER"
   */
  (name?: string): BrowserBinding;
}

export const Browser = Binding.Service<Browser>({
  id: TypeId,
  defaultName: "BROWSER",
  toWorkerBinding: (binding) => ({
    type: "browser",
    name: binding.name,
  }),
});

export const isBrowser = (value: unknown): value is BrowserBinding =>
  Binding.isBinding(value) && value.kind === TypeId;
