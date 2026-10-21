import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { afterEach, vi } from "vitest";
import * as WorkerProxy from "../proxy/WorkerProxy.ts";
import * as Runtime from "../Runtime.ts";
import { localRuntimeLayer, PredicateFailed } from "./helpers/runtime.ts";

const HELLO_SCRIPT = `
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/hello") return new Response("hello");
    if (url.pathname === "/echo") return new Response(request.method);
    return new Response("not found", { status: 404 });
  }
};
`;

/** A port that was free a moment ago, for listeners that need a fixed address. */
const freePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as NodeNet.AddressInfo;
    server.close(() => resume(Effect.succeed(port)));
  });
});

layer(localRuntimeLayer, { excludeTestServices: true })("Runtime", (it) => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect(
    "exposes the V8 inspector for the worker named by WORKERD_INSPECTOR_WORKER",
    () =>
      Effect.gen(function* () {
        const port = yield* freePort;
        vi.stubEnv("WORKERD_INSPECTOR_WORKER", "inspected");
        vi.stubEnv("WORKERD_INSPECTOR_ADDR", `127.0.0.1:${port}`);
        const runtime = yield* Runtime.Runtime;
        const worker = (name: string) =>
          runtime.start({
            name,
            compatibilityDate: "2026-03-10",
            compatibilityFlags: [],
            bindings: [],
            modules: [{ name: "main.js", type: "ESModule", content: HELLO_SCRIPT }],
          });
        yield* worker("inspected");
        const targets = yield* Effect.tryPromise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/json`, {
            signal: AbortSignal.timeout(10_000),
          });
          return (await response.json()) as Array<{ webSocketDebuggerUrl?: string }>;
        });
        expect(targets.length).toBeGreaterThan(0);
        expect(targets[0].webSocketDebuggerUrl).toMatch(/^ws:\/\//);
        // Any other worker starts without the inspector: binding the same
        // address in a second workerd process would fail its startup.
        const other = yield* worker("other");
        const hello = yield* Effect.promise(() => fetch(new URL("/hello", other)));
        expect(yield* Effect.promise(() => hello.text())).toBe("hello");
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "starts a worker and returns an http://127.0.0.1:<port> URL",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        const url = yield* runtime.start({
          name: "smoke",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: HELLO_SCRIPT }],
        });
        expect(url).toBeInstanceOf(URL);
        expect(url.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        const hello = yield* Effect.promise(() => fetch(new URL("/hello", url)));
        expect(hello.status).toBe(200);
        expect(yield* Effect.promise(() => hello.text())).toBe("hello");
        const echo = yield* Effect.promise(() => fetch(new URL("/echo", url), { method: "POST" }));
        expect(yield* Effect.promise(() => echo.text())).toBe("POST");
      }),
    { timeout: 30_000 },
  );

  it.effect("surfaces user-script errors as ConfigError", () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const error = yield* runtime
        .start({
          name: "broken",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: "this is not valid javascript ===",
            },
          ],
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ConfigError");
    }),
  );
  it.effect(
    "starts many workers concurrently, including proxy",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        const proxy = yield* WorkerProxy.WorkerProxy;

        const start = (index: number) =>
          Effect.gen(function* () {
            const instance = yield* proxy.serve();
            const worker = yield* runtime.start({
              name: `smoke-${index}`,
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [{ name: "main.js", type: "ESModule", content: HELLO_SCRIPT }],
            });
            yield* instance.set(worker);
            return instance.url;
          });

        const count = 25;
        const urls = yield* Effect.all(
          Array.from({ length: count }, (_, index) => start(index)),
          { concurrency: "unbounded" },
        );
        expect(new Set(urls).size).toBe(count);
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "surfaces uncaught worker exceptions via logging.verbose + onOutput",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        let captured = "";
        const url = yield* runtime.start({
          name: "throwing",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: `
                export default {
                  fetch() {
                    throw new Error("kaboom-marker");
                  },
                };
              `,
            },
          ],
          logging: {
            verbose: true,
            onOutput: (chunk) => {
              captured += chunk;
            },
          },
        });
        const res = yield* Effect.promise(() => fetch(new URL("/", url)));
        expect(res.status).toBe(500);
        // workerd writes the exception asynchronously; wait for it to land.
        yield* Effect.suspend(() =>
          captured.includes("kaboom-marker")
            ? Effect.void
            : Effect.fail(new PredicateFailed({ value: captured })),
        ).pipe(
          Effect.retry({
            while: (error) => error._tag === "PredicateFailed",
            schedule: Schedule.spaced("50 millis"),
            times: 100,
          }),
        );
        expect(captured).toContain("kaboom-marker");
      }),
    { timeout: 30_000 },
  );

  // Bun's HTTP parser keeps only the last of repeated header lines, so the
  // runtime sends each repeated header as one comma-joined line.
  it.effect(
    "sends repeated response headers as one line, keeping Set-Cookie lines",
    () =>
      Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        const url = yield* runtime.start({
          name: "repeated-headers",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: `export default {
  fetch() {
    const response = new Response("ok");
    for (const value of ["one", "two", "three"]) response.headers.append("x-multi", value);
    response.headers.append("set-cookie", "a=1");
    response.headers.append("set-cookie", "b=2");
    return response;
  }
};`,
            },
          ],
        });
        const rawHeaders = yield* Effect.promise(
          () =>
            new Promise<Array<string>>((resolve, reject) =>
              NodeHttp.get(url, (res) => {
                res.resume();
                resolve(res.rawHeaders);
              }).on("error", reject),
            ),
        );
        const lines = (name: string) =>
          rawHeaders.flatMap((value, index) =>
            index % 2 === 1 && rawHeaders[index - 1]!.toLowerCase() === name ? [value] : [],
          );
        expect(lines("x-multi")).toEqual(["one, two, three"]);
        expect(lines("set-cookie")).toEqual(["a=1", "b=2"]);
      }),
    { timeout: 30_000 },
  );
});
