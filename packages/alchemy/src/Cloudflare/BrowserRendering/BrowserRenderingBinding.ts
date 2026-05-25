import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { BrowserRendering as BrowserRenderingLike } from "./BrowserRendering.ts";

export class BrowserRenderingError extends Data.TaggedError(
  "BrowserRenderingError",
)<{
  message: string;
  cause: unknown;
}> {}

export interface BrowserRenderingBrowser {
  close(): Promise<void>;
}

export interface BrowserRenderingPuppeteer<
  Browser extends BrowserRenderingBrowser,
> {
  launch(binding: cf.Fetcher): Promise<Browser>;
}

/**
 * Effect-native client for a Cloudflare Browser Rendering binding.
 *
 * Browser Rendering's Workers binding is consumed by `@cloudflare/puppeteer`.
 * Alchemy keeps Puppeteer as a caller-provided dependency while wrapping
 * launch and cleanup in Effects.
 */
export interface BrowserRenderingClient {
  /**
   * Effect resolving to the raw Cloudflare Browser Rendering runtime binding.
   */
  raw: Effect.Effect<cf.Fetcher, never, WorkerEnvironment>;
  /**
   * Launch a Browser Rendering session through `@cloudflare/puppeteer`.
   */
  launch<Browser extends BrowserRenderingBrowser>(
    puppeteer: BrowserRenderingPuppeteer<Browser>,
  ): Effect.Effect<Browser, BrowserRenderingError, WorkerEnvironment>;
  /**
   * Launch a browser, run an Effect with it, and close it afterward.
   */
  withBrowser<Browser extends BrowserRenderingBrowser, A, E, R>(
    puppeteer: BrowserRenderingPuppeteer<Browser>,
    use: (browser: Browser) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, BrowserRenderingError | E, WorkerEnvironment | R>;
}

export class BrowserRenderingBinding extends Binding.Service<
  BrowserRenderingBinding,
  (browser: BrowserRenderingLike) => Effect.Effect<BrowserRenderingClient>
>()("Cloudflare.BrowserRendering.Binding") {}

export const BrowserRenderingBindingLive = Layer.effect(
  BrowserRenderingBinding,
  Effect.gen(function* () {
    const Policy = yield* BrowserRenderingBindingPolicy;

    return Effect.fn(function* (browser: BrowserRenderingLike) {
      yield* Policy(browser);
      // Cloudflare exposes Browser Rendering as a service-style binding for
      // @cloudflare/puppeteer; workers-types has no narrower interface.
      const raw = WorkerEnvironment.useSync(
        (env) => (env as Record<string, cf.Fetcher>)[browser.name]!,
      );
      return makeBrowserRenderingClient(raw);
    });
  }),
);

export class BrowserRenderingBindingPolicy extends Binding.Policy<
  BrowserRenderingBindingPolicy,
  (browser: BrowserRenderingLike) => Effect.Effect<void>
>()("Cloudflare.BrowserRendering.Binding") {}

export const BrowserRenderingBindingPolicyLive =
  BrowserRenderingBindingPolicy.layer.succeed(
    Effect.fn(function* (host: ResourceLike, browser: BrowserRenderingLike) {
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
          new Error(
            `BrowserRenderingBinding does not support runtime '${host.Type}'`,
          ),
        );
      }
    }),
  );

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, BrowserRenderingError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new BrowserRenderingError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown Browser Rendering error",
        cause: error,
      }),
  });

/** @internal */
export const makeBrowserRenderingClient = (
  raw: Effect.Effect<cf.Fetcher, never, WorkerEnvironment>,
): BrowserRenderingClient => {
  const launch = <Browser extends BrowserRenderingBrowser>(
    puppeteer: BrowserRenderingPuppeteer<Browser>,
  ) =>
    raw.pipe(
      Effect.flatMap((binding) => tryPromise(() => puppeteer.launch(binding))),
    );

  return {
    raw,
    launch,
    withBrowser: (puppeteer, use) =>
      Effect.acquireUseRelease(launch(puppeteer), use, (browser) =>
        tryPromise(() => browser.close()),
      ),
  } satisfies BrowserRenderingClient;
};
