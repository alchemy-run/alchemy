import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";

const fixtureMain = fileURLToPath(
  new URL("./fixtures/drizzle-schema-chunks/worker.ts", import.meta.url),
);

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

/**
 * Regression stack for https://github.com/alchemy-run/alchemy/issues/749.
 *
 * The `build.output.codeSplitting` groups force the chunk layout from the
 * issue: top-level Drizzle schema modules (`schema/*`, `auth/*`) in their own
 * `auth-*` chunk, `drizzle-orm` in a separate `drizzle-*` chunk. Without
 * WorkerBundle's default `strictExecutionOrder: true`, workerd evaluates the
 * schema chunk before drizzle's class bindings initialize and Cloudflare
 * rejects the upload with `ScriptStartupError: Cannot access '<minified>'
 * before initialization` — so the deploy in `beforeAll` is itself the
 * regression assertion.
 */
const Stack = Alchemy.Stack(
  "DrizzleSchemaChunksTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("DrizzleSchemaChunks", {
      main: fixtureMain,
      compatibility: { date: "2026-06-24", flags: ["nodejs_compat"] },
      build: {
        output: {
          codeSplitting: {
            groups: [
              // Claim drizzle-orm first so the schema group can't
              // recursively capture it into the same chunk. String tests
              // are regex patterns; RegExp literals wouldn't survive the
              // engine's props serialization.
              { name: "drizzle", test: "drizzle-orm" },
              { name: "auth", test: "drizzle-schema-chunks/(schema|auth)/" },
            ],
          },
        },
      },
    });
    return { url: worker.url.as<string>() };
  }),
);

const bundleDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(".alchemy/bundles/DrizzleSchemaChunks");
});

const stack = beforeAll(
  Effect.gen(function* () {
    // Drop chunks from previous runs so the chunk-layout assertion below
    // can't pass on stale files.
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(yield* bundleDir, { recursive: true }).pipe(Effect.ignore);
    return yield* deploy(Stack);
  }),
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "worker with drizzle schema modules split into their own chunk deploys and serves (#749)",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // The forced split actually happened: a standalone schema chunk exists
    // separately from the drizzle-orm chunk.
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs.readDirectory(yield* bundleDir);
    expect(files.some((f) => /^auth-.*\.js$/.test(f))).toBe(true);
    expect(files.some((f) => /^drizzle-.*\.js$/.test(f))).toBe(true);

    // The worker evaluated its cross-chunk schema at startup and serves.
    const client = yield* HttpClient.HttpClient;
    const body = yield* client.get(url).pipe(
      Effect.flatMap((res) => res.text),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 5,
      }),
      // Fresh workers.dev URLs can serve placeholder pages while propagating.
      Effect.repeat({
        schedule: Schedule.exponential("500 millis"),
        until: (b) => b.includes('"ok":true'),
        times: 10,
      }),
      Effect.orDie,
    );
    expect(body).toContain('"ok":true');
  }),
  { timeout: 180_000 },
);
