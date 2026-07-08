import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import TestLogEffectWorker from "./effect-worker.ts";

const asyncMain = pathe.resolve(import.meta.dirname, "async-worker.ts");

/**
 * Stack with one Effect-native worker and one plain external worker, both
 * logging from `fetch`. Note there is nothing test-logging-specific here —
 * the instrumentation is injected entirely by the harness/provider.
 */
export default Alchemy.Stack(
  "TestLoggingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const effectWorker = yield* TestLogEffectWorker;

    const asyncWorker = yield* Cloudflare.Worker("TestLogAsyncWorker", {
      main: asyncMain,
      url: true,
    });

    return {
      effectUrl: effectWorker.url.as<string>(),
      asyncUrl: asyncWorker.url.as<string>(),
      effectName: effectWorker.workerName.as<string>(),
      asyncName: asyncWorker.workerName.as<string>(),
    };
  }),
);
