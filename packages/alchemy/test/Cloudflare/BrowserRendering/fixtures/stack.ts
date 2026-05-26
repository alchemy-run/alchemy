import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import BrowserRenderingEffectWorker from "./effect-worker.ts";

const asyncWorkerMain = pathe.resolve(import.meta.dirname, "async-worker.ts");

const Browser = Cloudflare.BrowserRendering({ name: "BROWSER" });

export const AsyncWorker = Cloudflare.Worker("BrowserRenderingAsyncWorker", {
  main: asyncWorkerMain,
  compatibility: {
    flags: ["nodejs_compat"],
  },
  bindings: {
    BROWSER: Browser,
  },
});

export type AsyncWorkerEnv = Cloudflare.InferEnv<typeof AsyncWorker>;

export default Alchemy.Stack(
  "BrowserRenderingBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const asyncWorker = yield* AsyncWorker;
    const effectWorker = yield* BrowserRenderingEffectWorker;

    return {
      asyncWorkerUrl: asyncWorker.url.as<string>(),
      effectWorkerUrl: effectWorker.url.as<string>(),
    };
  }),
);
