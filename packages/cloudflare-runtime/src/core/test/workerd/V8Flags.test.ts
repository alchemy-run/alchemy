import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, it, vi } from "vitest";
import type { Config } from "../../workerd/Config.ts";
import * as Workerd from "../../workerd/Workerd.ts";

describe("parseV8Flags", () => {
  it("splits on whitespace and drops empty entries", () => {
    expect(
      Workerd.parseV8Flags("  --expose-gc \n --max-old-space-size=4096  "),
    ).toEqual(["--expose-gc", "--max-old-space-size=4096"]);
  });

  it("yields no flags when the variable is unset or blank", () => {
    expect(Workerd.parseV8Flags(undefined)).toEqual([]);
    expect(Workerd.parseV8Flags("")).toEqual([]);
    expect(Workerd.parseV8Flags("   ")).toEqual([]);
  });
});

const services = Layer.provide(Workerd.WorkerdLive, NodeServices.layer);

/**
 * `--expose-gc` is observable from inside the isolate: `globalThis.gc` only
 * exists when V8 started with the flag, so the response tells whether the
 * flags reached the process.
 */
const serveGcProbe = (config: Pick<Config, "v8Flags"> = {}) =>
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const ports = yield* workerd.serve({
      ...config,
      sockets: [
        { name: "http", address: "127.0.0.1:0", service: { name: "test" } },
      ],
      services: [
        {
          name: "test",
          worker: {
            compatibilityDate: "2026-03-10",
            modules: [
              {
                name: "main.js",
                esModule:
                  "export default { fetch: () => new Response(typeof globalThis.gc) };",
              },
            ],
          },
        },
      ],
    });
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${ports.http}/`, {
        signal: AbortSignal.timeout(10_000),
      }),
    );
    return yield* Effect.promise(() => response.text());
  });

layer(services)("v8Flags", (it) => {
  it.effect(
    "starts workerd without extra V8 flags by default",
    () =>
      Effect.gen(function* () {
        expect(yield* serveGcProbe()).toBe("undefined");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "passes the config's v8Flags to workerd",
    () =>
      Effect.gen(function* () {
        expect(yield* serveGcProbe({ v8Flags: ["--expose-gc"] })).toBe(
          "function",
        );
      }),
    { timeout: 30_000 },
  );

  it.effect(
    `passes the flags in ${Workerd.V8_FLAGS_ENV} to workerd`,
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--expose-gc");
        expect(yield* serveGcProbe()).toBe("function");
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
    { timeout: 30_000 },
  );
});
