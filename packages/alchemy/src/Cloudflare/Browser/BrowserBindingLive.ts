import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { Browser as BrowserLike } from "./Browser.ts";
import { BrowserBinding, makeBrowserClient } from "./BrowserBinding.ts";

/**
 * Implementation of the {@link BrowserBinding} binding that uses a Worker
 * binding. Registers the `browser` binding on the host Worker at deploy time,
 * then exposes the Effect-native client.
 */
export const BrowserBindingLive = Layer.effect(
  BrowserBinding,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (browser: BrowserLike) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind(browser.name, {
          bindings: [
            {
              type: "browser",
              name: browser.name,
            },
          ],
        });
      }
      const raw: Effect.Effect<cf.BrowserRun, never, RuntimeContext> =
        Effect.sync(
          () => (env as Record<string, cf.BrowserRun>)[browser.name]!,
        );
      return makeBrowserClient(raw);
    });
  }),
);
