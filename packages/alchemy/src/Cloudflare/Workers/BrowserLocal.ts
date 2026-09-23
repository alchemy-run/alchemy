import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { makeLocalBrowserClient } from "@alchemy.run/cloudflare-runtime/core/bindings/browser";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import { Browser } from "./Browser.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";
import {
  type BrowserAuth,
  makeHttpBrowserClient,
} from "./BrowserHttpClient.ts";

/**
 * Action-side implementation of the {@link Browser} binding. During local dev,
 * quick actions use the runtime's local Chrome without Cloudflare credentials.
 * Outside dev, or with `Alchemy.remote()`, calls use Cloudflare's REST API with
 * the current credentials.
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to run the JSON
 * quick actions — `content`, `markdown`, `scrape`, `links`, `snapshot`,
 * `json` — with the same client you'd use inside a Worker; no Worker host, no
 * `host.bind`, no minted token:
 *
 * @example Convert a page to Markdown from an Action
 * ```typescript
 * const Scrape = Alchemy.Action(
 *   "Scrape",
 *   Effect.gen(function* () {
 *     const browser = yield* Cloudflare.Browser("BROWSER");
 *     return Effect.fn(function* () {
 *       const { result } = yield* browser.markdown({
 *         url: "https://example.com",
 *       });
 *       return result;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Workers.BrowserLocal)),
 * );
 * ```
 *
 * Local quick actions support content, Markdown, links, scraping, screenshots,
 * PDFs, and snapshots. AI JSON extraction requires `Alchemy.remote()`.
 * `raw` and `fetch` require a Worker Browser binding for session lifetime.
 * The remote HTTP client does not support binary actions.
 */
export const BrowserLocal = Layer.effect(
  Browser,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the REST ops run with the
    // current credentials — no `host.bind`, no minted token.
    const environment = yield* CloudflareEnvironment;
    const { dev } = yield* AlchemyContext;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    return Effect.fn(function* (binding: BrowserBinding) {
      if (dev && !binding.devRemote) return makeLocalBrowserClient();
      const { accountId } = yield* environment;
      const auth: BrowserAuth = {
        authorize: (eff) => eff.pipe(Effect.provideContext(context)),
        accountId,
      };
      return makeHttpBrowserClient(auth);
    });
  }),
);
