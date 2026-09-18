import { findAvailablePort, nodeLoaderArgs } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, it } from "alchemy-test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const services = Layer.mergeAll(PlatformServices, FetchHttpClient.layer);

const spawnFixture = (
  env: Record<string, string | undefined> = {},
  waitForReady = true,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fixture = yield* path.fromFileUrl(
      new URL("./fixtures/managed-http-shutdown.ts", import.meta.url),
    );
    const port = yield* findAvailablePort();
    const args = yield* Effect.sync(() => nodeLoaderArgs(fixture));
    const handle = yield* ChildProcess.make("node", [...args, fixture], {
      env: {
        ALCHEMY_STACK_NAME: "managed-http-shutdown",
        ALCHEMY_STAGE: "test",
        ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "3000",
        PORT: String(port),
        ...env,
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL",
    });
    const output: string[] = [];
    const ready = yield* Deferred.make<void>();
    yield* Stream.merge(handle.stdout, handle.stderr).pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          output.push(chunk);
          if (chunk.includes("ready")) Deferred.doneUnsafe(ready, Effect.void);
        }),
      ),
      Effect.forkScoped,
    );
    if (waitForReady) {
      yield* Deferred.await(ready).pipe(
        Effect.timeout("15 seconds"),
        Effect.tapError(() => Effect.logError(output.join(""))),
      );
    }
    const client = yield* HttpClient.HttpClient;
    return {
      handle,
      output: () => output.join(""),
      signal: (signal: "SIGTERM" | "SIGINT") =>
        Effect.sync(() => process.kill(handle.pid, signal)),
      get: (route: string) =>
        client.get(`http://127.0.0.1:${port}${route}`, {
          headers: { connection: "close" },
        }),
    };
  });

const waitForOutput = (fixture: { output: () => string }, text: string) =>
  Effect.sync(fixture.output).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: (output) => output.includes(text),
      times: 80,
    }),
    Effect.tap((output) => Effect.sync(() => expect(output).toContain(text))),
  );

const refusesNewRequests = (
  fixture: Effect.Success<ReturnType<typeof spawnFixture>>,
) =>
  fixture.get("/health").pipe(
    Effect.timeout("200 millis"),
    Effect.result,
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: Result.isFailure,
      times: 8,
    }),
    Effect.tap((result) =>
      Effect.sync(() => expect(Result.isFailure(result)).toBe(true)),
    ),
  );

const assertFinalizerOrder = (output: string, finished: string) => {
  expect(output.indexOf(finished)).toBeGreaterThanOrEqual(0);
  expect(output.indexOf("request finalized")).toBeGreaterThan(
    output.indexOf(finished),
  );
  expect(output.indexOf("instance finalizing")).toBeGreaterThan(
    output.indexOf("request finalized"),
  );
  expect(output).toContain("instance finalized");
};

describe("managed Fly HTTP shutdown", () => {
  it.live(
    "SIGTERM stops acceptance and drains a slow response before instance finalizers",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        const response = yield* fixture.get("/slow").pipe(
          Effect.flatMap((response) => response.text),
          Effect.forkChild,
        );
        yield* waitForOutput(fixture, "request started");
        yield* fixture.signal("SIGTERM");
        yield* refusesNewRequests(fixture);
        yield* fixture.signal("SIGINT");
        expect(yield* Fiber.join(response)).toBe("completed");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        assertFinalizerOrder(fixture.output(), "response ready");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "SIGINT drains the entire streaming body before closing scopes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture();
        const first = yield* Deferred.make<void>();
        const chunks: string[] = [];
        const response = yield* fixture.get("/stream").pipe(
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.decodeText,
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  chunks.push(chunk);
                  Deferred.doneUnsafe(first, Effect.void);
                }),
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        yield* fixture.signal("SIGINT");
        yield* refusesNewRequests(fixture);
        yield* Fiber.join(response);
        expect(chunks.join("")).toBe("first\nsecond\nlast\n");
        expect(yield* fixture.handle.exitCode).toBe(0);
        yield* waitForOutput(fixture, "instance finalized");
        assertFinalizerOrder(fixture.output(), "chunk last");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "closes a stalled stream at the drain deadline and finishes instance cleanup",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
        });
        const first = yield* Deferred.make<void>();
        const response = yield* fixture.get("/stream-hang").pipe(
          Effect.flatMap((response) =>
            response.stream.pipe(
              Stream.runForEach(() => Deferred.succeed(first, undefined)),
            ),
          ),
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(first);
        const started = yield* Effect.sync(() => performance.now());
        yield* fixture.signal("SIGTERM");
        expect(Result.isFailure(yield* Fiber.join(response))).toBe(true);
        expect(yield* fixture.handle.exitCode).toBe(0);
        const elapsed = yield* Effect.sync(() => performance.now() - started);
        expect(elapsed).toBeGreaterThanOrEqual(1500);
        expect(elapsed).toBeLessThan(2000);
        yield* waitForOutput(fixture, "instance finalized");
        assertFinalizerOrder(fixture.output(), "chunk last");
        expect(fixture.output()).toContain("drain deadline exceeded");
        expect(fixture.output()).not.toContain("shutdown deadline exceeded");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  it.live(
    "bounds a stuck request and instance finalizer below the Fly stop deadline",
    () =>
      Effect.gen(function* () {
        const fixture = yield* spawnFixture({
          ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: "2000",
          HANG_FINALIZER: "1",
        });
        const response = yield* fixture
          .get("/hang")
          .pipe(Effect.result, Effect.forkChild);
        yield* waitForOutput(fixture, "request started");
        const started = yield* Effect.sync(() => performance.now());
        yield* fixture.signal("SIGTERM");
        yield* refusesNewRequests(fixture);
        expect(yield* fixture.handle.exitCode).toBe(1);
        const elapsed = yield* Effect.sync(() => performance.now() - started);
        expect(elapsed).toBeGreaterThanOrEqual(1500);
        expect(elapsed).toBeLessThan(2000);
        expect(Result.isFailure(yield* Fiber.join(response))).toBe(true);
        yield* waitForOutput(fixture, "shutdown deadline exceeded");
        expect(fixture.output()).toContain("request finalized");
        expect(fixture.output()).toContain("instance finalizing");
        expect(fixture.output()).not.toContain("instance finalized");
      }).pipe(Effect.scoped, Effect.provide(services)),
    { timeout: 25_000 },
  );

  for (const [name, env] of [
    [
      "Fly without the shutdown env",
      { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: undefined },
    ],
    ["unrelated hosts even with the Fly env", { UNMANAGED_HOST: "1" }],
  ] as const) {
    it.live(
      `preserves default signal behavior for ${name}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture(env);
          const response = yield* fixture
            .get("/slow")
            .pipe(Effect.result, Effect.forkChild);
          yield* waitForOutput(fixture, "request started");
          yield* fixture.signal("SIGTERM");
          const exit = yield* fixture.handle.exitCode.pipe(Effect.result);
          expect(Result.isFailure(exit)).toBe(true);
          expect(Result.isFailure(yield* Fiber.join(response))).toBe(true);
          expect(fixture.output()).not.toContain("response ready");
          expect(fixture.output()).not.toContain("instance finalizing");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }

  for (const timeout of ["0", "-1", "1.5", "invalid"]) {
    it.live(
      `rejects invalid shutdown timeout ${timeout}`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* spawnFixture(
            { ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS: timeout },
            false,
          );
          expect(yield* fixture.handle.exitCode).toBe(1);
          yield* waitForOutput(fixture, "must be a positive integer");
          expect(fixture.output()).not.toContain("ready");
        }).pipe(Effect.scoped, Effect.provide(services)),
      { timeout: 25_000 },
    );
  }
});
