import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { vi } from "vitest";
import * as Runtime from "../Runtime.ts";
import * as Workerd from "../workerd/Workerd.ts";
import { localRuntimeLayer } from "./helpers/runtime.ts";

/**
 * `/crash` exhausts the isolate's heap. With a small `--max-old-space-size`
 * V8 aborts the process the way it does in a long dev session, only faster.
 */
const CRASHING_SCRIPT = `
const hog = [];
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/crash") {
      for (;;) hog.push(new Array(1_000_000).fill(url.pathname));
    }
    return new Response("hello");
  },
};
`;

const fetchText = (url: URL) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return await response.text();
  });

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Runtime restart",
  (it) => {
    it.effect(
      "replaces workerd on the same port after it aborts",
      () =>
        Effect.gen(function* () {
          vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
          const runtime = yield* Runtime.Runtime;
          const exits: Array<Workerd.WorkerdExit> = [];
          const url = yield* runtime.start({
            name: "restarting",
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [],
            bindings: [],
            modules: [
              { name: "main.js", type: "ESModule", content: CRASHING_SCRIPT },
            ],
            onRestart: (exit) => {
              exits.push(exit);
            },
          });
          expect(yield* fetchText(new URL("/hello", url))).toBe("hello");

          // The request that kills the process gets no response.
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);

          // The replacement answers on the very same URL.
          const answer = yield* fetchText(new URL("/hello", url)).pipe(
            Effect.retry({
              schedule: Schedule.spaced("250 millis"),
              times: 80,
            }),
          );
          expect(answer).toBe("hello");
          expect(exits).toHaveLength(1);
          expect(exits[0].stderr).toContain("JavaScript heap out of memory");
        }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
      { timeout: 60_000 },
    );

    it.effect(
      "does not report a restart when the scope closes",
      () =>
        Effect.gen(function* () {
          const exits: Array<Workerd.WorkerdExit> = [];
          yield* Effect.gen(function* () {
            const runtime = yield* Runtime.Runtime;
            const url = yield* runtime.start({
              name: "closing",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                {
                  name: "main.js",
                  type: "ESModule",
                  content: CRASHING_SCRIPT,
                },
              ],
              onRestart: (exit) => {
                exits.push(exit);
              },
            });
            expect(yield* fetchText(new URL("/hello", url))).toBe("hello");
          }).pipe(Effect.scoped);
          // Give a wrongly reported exit time to arrive.
          yield* Effect.promise(
            () => new Promise((resolve) => setTimeout(resolve, 1_000)),
          );
          expect(exits).toHaveLength(0);
        }),
      { timeout: 30_000 },
    );
  },
);
