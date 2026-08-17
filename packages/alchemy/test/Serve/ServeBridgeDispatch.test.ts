/**
 * `Serve.toHandler` dispatch through a class-carried serve shell (the Lambda
 * shell the effectful AWS website arms stamp on their classes).
 *
 * These are process-exclusive unit tests: `Serve.toHandler` stamps
 * `globalThis.__ALCHEMY_RUNTIME__` process-wide (by design — real runtimes
 * never plan), which would flip concurrently-running plan tests into the
 * runtime branch. They lived in test/AWS/Website/EffectfulSibling.test.ts,
 * where each exclusive test FIFO-barriered the whole live CloudFront
 * directory run behind a ~7-minute in-flight deploy drain (2x wall-clock
 * for `bun run test test/AWS/Website`). They are Serve unit tests, so they
 * live here with the sub-second suites instead.
 */
import * as AWS from "@/AWS";
import { lambdaServeBridge } from "@/AWS/Lambda/ServeBridge.ts";
import * as Serve from "@/Serve/Serve.ts";
import { SERVE_BRIDGE_KEY } from "@/Serve/constants.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const okFetch = {
  fetch: Effect.succeed(HttpServerResponse.text("ok")),
};

describe.concurrent("AWS serve shell dispatch", () => {
  it("effectful Next/Nuxt class arms carry the Lambda serve shell", () => {
    class NextSite extends AWS.Website.Nextjs<NextSite>()(
      "ShellNextSite",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    class NuxtSite extends AWS.Website.Nuxt<NuxtSite>()(
      "ShellNuxtSite",
      { main: import.meta.url },
      Effect.succeed(okFetch),
    ) {}
    expect((NextSite as any)[SERVE_BRIDGE_KEY]).toBe(lambdaServeBridge);
    expect((NuxtSite as any)[SERVE_BRIDGE_KEY]).toBe(lambdaServeBridge);
  });

  /**
   * `Serve.toHandler` stamps `globalThis.__ALCHEMY_RUNTIME__` process-wide (by
   * design — real runtimes never plan). In the shared test process that flag
   * flips concurrently-running plan tests into the runtime branch, so these
   * tests take the whole-process write lock (`exclusive`) and restore the
   * flag afterwards (the FetchHandler.test.ts pattern).
   */
  const restoringRuntimeFlag = async (body: () => Promise<void>) => {
    const previous = globalThis.__ALCHEMY_RUNTIME__;
    try {
      await body();
    } finally {
      globalThis.__ALCHEMY_RUNTIME__ = previous;
    }
  };

  it(
    "Serve.toHandler dispatches to a class-carried shell",
    () =>
      restoringRuntimeFlag(async () => {
        const calls: Array<{ site: object; url: string }> = [];
        const site = {
          "~alchemy/Id": "FakeSite",
          [SERVE_BRIDGE_KEY]: {
            match: (s: object, request: Request) => {
              calls.push({ site: s, url: request.url });
              return Promise.resolve(new Response("from-shell"));
            },
          },
        };
        const handle = Serve.toHandler(site as any);
        const response = await handle.match(new Request("http://x/api/a"));
        expect(await response!.text()).toBe("from-shell");
        expect(calls).toHaveLength(1);
        expect(calls[0].site).toBe(site);
      }),
    { exclusive: true },
  );

  it(
    "the Lambda shell declines marker-less environments (prerender world)",
    () =>
      restoringRuntimeFlag(async () => {
        class DeclineSite extends AWS.Website.Nextjs<DeclineSite>()(
          "ShellDeclineSite",
          { main: import.meta.url },
          Effect.succeed(okFetch),
        ) {}
        const handle = Serve.toHandler(DeclineSite as any, {
          // No ALCHEMY_STACK_NAME: the four-worlds guard must decline
          // without building any layers (a `next build` prerender world).
          env: { SOME_VAR: "1" },
        });
        const matched = await handle.match(new Request("http://x/api/a"));
        expect(matched).toBeUndefined();
      }),
    { exclusive: true },
  );
});
