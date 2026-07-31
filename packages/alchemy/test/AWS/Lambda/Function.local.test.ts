import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { remote } from "@/ProviderMode.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({
  providers: AWS.providers(),
  dev: true,
});

class LiveTracer extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "LiveLambdaTracer",
) {}

const handlerSource = (version: string) => `
import * as Lambda from "alchemy/AWS/Lambda";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

class LiveTracer extends Lambda.Function<Lambda.Function>()(
  "LiveLambdaTracer",
) {}

export default LiveTracer.make(
  { main: import.meta.url, url: true },
  Effect.succeed({
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      return yield* HttpServerResponse.json({
        version: ${JSON.stringify(version)},
        path: new URL(request.originalUrl).pathname,
        platform: process.platform,
      });
    }),
  }),
);
`;

const readVersion = (url: string, expected: string, platform: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Function URL returned ${response.status}`)),
    ),
    Effect.filterOrFail(
      (body): body is { version: string; path: string; platform: string } =>
        typeof body === "object" &&
        body !== null &&
        "version" in body &&
        body.version === expected &&
        "platform" in body &&
        body.platform === platform,
      (body) =>
        new Error(
          `expected Live Lambda version ${expected}, received ${JSON.stringify(body)}`,
        ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.spaced("1 second"),
        Schedule.recurs(90),
      ]),
    }),
  );

/**
 * Vertical tracer for Live Lambda:
 *
 * The same Function URL and physical Lambda survive live -> local -> live.
 * In local mode invocations cross the deployed bridge and AppSync Events to
 * the local handler, and a source edit is observed without reconciling AWS.
 */
test.provider(
  "preserves one Lambda while switching between live and hot-reloaded local code",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureDir = path.resolve(
        import.meta.dirname,
        "../../..",
        ".alchemy",
        "test",
        `live-lambda-${crypto.randomUUID()}`,
      );
      yield* fs.makeDirectory(fixtureDir, { recursive: true });
      yield* Effect.addFinalizer(() =>
        fs.remove(fixtureDir, { recursive: true }).pipe(Effect.ignore),
      );
      const main = path.join(fixtureDir, "handler.ts");
      yield* fs.writeFileString(main, handlerSource("v1"));
      const entrypoint = LiveTracer.make(
        { main, url: true },
        // The plan-side implementation is not executed at runtime; the
        // watcher bundles the matching Effect Function in `main`.
        Effect.succeed({}) as any,
      );

      yield* stack.destroy();
      const live = yield* stack.deploy(
        LiveTracer.pipe(remote(), Effect.provide(entrypoint)),
      );

      expect(typeof live.functionUrl).toBe("string");
      expect(
        yield* readVersion(`${live.functionUrl}tracer`, "v1", "linux"),
      ).toEqual({
        version: "v1",
        path: "/tracer",
        platform: "linux",
      });

      const local = yield* stack.deploy(
        LiveTracer.pipe(Effect.provide(entrypoint)),
      );
      expect(local.functionName).toEqual(live.functionName);
      expect(local.functionArn).toEqual(live.functionArn);
      expect(local.functionUrl).toEqual(live.functionUrl);
      expect(
        yield* readVersion(
          `${local.functionUrl}tracer`,
          "v1",
          process.platform,
        ),
      ).toEqual({
        version: "v1",
        path: "/tracer",
        platform: process.platform,
      });

      yield* fs.writeFileString(main, handlerSource("v2"));
      expect(
        yield* readVersion(
          `${local.functionUrl}tracer`,
          "v2",
          process.platform,
        ),
      ).toEqual({ version: "v2", path: "/tracer", platform: process.platform });

      const restored = yield* stack.deploy(
        LiveTracer.pipe(remote(), Effect.provide(entrypoint)),
      );
      expect(restored.functionName).toEqual(live.functionName);
      expect(restored.functionArn).toEqual(live.functionArn);
      expect(restored.functionUrl).toEqual(live.functionUrl);
      expect(
        yield* readVersion(`${restored.functionUrl}tracer`, "v2", "linux"),
      ).toEqual({ version: "v2", path: "/tracer", platform: "linux" });

      yield* stack.destroy();
    }),
  { timeout: 220_000 },
);
