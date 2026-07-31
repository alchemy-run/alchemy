import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
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
      });
    }),
  }),
);
`;

const readVersion = (url: string, expected: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Function URL returned ${response.status}`)),
    ),
    Effect.filterOrFail(
      (body): body is { version: string; path: string } =>
        typeof body === "object" &&
        body !== null &&
        "version" in body &&
        body.version === expected,
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
 * real Function URL -> deployed bridge -> AppSync Events -> local handler,
 * then a source edit is observed by the sidecar watcher without reconciling
 * the AWS function again.
 */
test.provider(
  "forwards real Lambda invocations to a hot-reloaded local handler",
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
      const fn = yield* stack.deploy(
        LiveTracer.pipe(Effect.provide(entrypoint)),
      );

      expect(fn.functionName).toMatch(/^alchemy-dev-/);
      expect(typeof fn.functionUrl).toBe("string");
      expect(yield* readVersion(`${fn.functionUrl}tracer`, "v1")).toEqual({
        version: "v1",
        path: "/tracer",
      });

      yield* fs.writeFileString(main, handlerSource("v2"));
      expect(yield* readVersion(`${fn.functionUrl}tracer`, "v2")).toEqual({
        version: "v2",
        path: "/tracer",
      });

      yield* stack.destroy();
    }),
  { timeout: 220_000 },
);
