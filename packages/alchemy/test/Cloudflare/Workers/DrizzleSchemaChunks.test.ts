import * as Bundle from "@/Bundle/Bundle";
import * as Cloudflare from "@/Cloudflare";
import cloudflareRolldown from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as rolldown from "rolldown";

/**
 * Matches schema modules in this fixture (`schema/*`, `auth/*`) — the
 * standalone `auth-*` chunk shape from #749.
 */
const schemaModuleTest = /(?:^|\/|\\)(?:schema|auth)(?:\/|\\)/;

const fixtureMain = fileURLToPath(
  new URL("./fixtures/drizzle-schema-chunks/worker.ts", import.meta.url),
);

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Mirror {@link WorkerBundle} defaults — except `strictExecutionOrder`,
 * which each case sets explicitly — then apply `codeSplitting` groups.
 * Alchemy's public `Worker.build` does not forward output chunk controls
 * (#749), so the repro drives {@link Bundle.build} directly and deploys the
 * result as a prebuilt Worker (`bundle: false`).
 */
const buildWorkerLike = Effect.fn(function* (options: {
  id: string;
  codeSplitting: rolldown.OutputOptions["codeSplitting"];
  strictExecutionOrder?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outDir = path.resolve(".alchemy/bundles", options.id);
  yield* fs.makeDirectory(outDir, { recursive: true });

  const output = yield* Bundle.build(
    {
      input: fixtureMain,
      cwd: path.dirname(fixtureMain),
      preserveEntrySignatures: "allow-extension",
      external: ["lightningcss", "fsevents"],
      plugins: [
        cloudflareRolldown({
          compatibilityDate: "2026-06-24",
          compatibilityFlags: ["nodejs_compat"],
        }),
      ],
      checks: {
        unresolvedImport: false,
        ineffectiveDynamicImport: false,
      },
    },
    {
      format: "esm",
      sourcemap: false,
      minify: true,
      keepNames: true,
      dir: outDir,
      codeSplitting: options.codeSplitting,
      strictExecutionOrder: options.strictExecutionOrder,
    },
  );

  return {
    outDir,
    main: path.join(outDir, output.files[0].path),
    jsFiles: output.files
      .map((file) => file.path)
      .filter((name) => name.endsWith(".js")),
  };
});

const deployPrebuilt = (logicalId: string, main: string) =>
  Cloudflare.Worker(logicalId, {
    main,
    bundle: false,
    subdomain: { enabled: true },
    compatibility: {
      date: "2026-06-24",
      flags: ["nodejs_compat"],
    },
  });

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  }
  if (error && typeof error === "object") {
    const tag =
      "_tag" in error && typeof error._tag === "string" ? error._tag : "";
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : "";
    return `${tag} ${message} ${JSON.stringify(error)}`;
  }
  return String(error);
};

/**
 * Repro for https://github.com/alchemy-run/alchemy/issues/749
 *
 * When Rolldown splits top-level Drizzle schema modules into a chunk away
 * from `drizzle-orm` — and no execution-order guard is applied — Cloudflare
 * rejects the Worker at script startup (`ScriptStartupError` / incomplete
 * cross-chunk class bindings). `WorkerBundle` now defaults to
 * `strictExecutionOrder: true`, which the next case shows fixes exactly
 * this split; this case pins the underlying failure by omitting it.
 */
test.provider(
  "Cloudflare rejects a Worker when schema chunks are split away from drizzle-orm (#749)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const built = yield* buildWorkerLike({
        id: "drizzle-schema-chunks-auth-alone",
        codeSplitting: {
          groups: [
            {
              name: "auth",
              test: schemaModuleTest,
              includeDependenciesRecursively: false,
            },
          ],
        },
      });

      // Sanity: we actually produced the standalone auth chunk.
      expect(built.jsFiles.some((name) => name.startsWith("auth-"))).toBe(true);

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* deployPrebuilt(
              "DrizzleSchemaChunksAuthAlone",
              built.main,
            );
          }),
        )
        .pipe(Effect.flip);

      // Cloudflare surfaces this as ScriptStartupError; the underlying
      // workerd message is either the classic TDZ form from the issue
      // (`Cannot access '<minified>' before initialization`) or the closely
      // related incomplete-binding form (`PgSerialBuilder is not a constructor`).
      const text = errorText(error);
      expect(text).toMatch(
        /ScriptStartupError|not a constructor|before initialization|Class extends value undefined/i,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// Pins the fix: `strictExecutionOrder: true` (now the WorkerBundle default)
// makes the identical bad split evaluate correctly in workerd.
test.provider(
  "strictExecutionOrder makes the same bad split deploy and serve (#749 fix)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const built = yield* buildWorkerLike({
        id: "drizzle-schema-chunks-strict-order",
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: "auth",
              test: schemaModuleTest,
              includeDependenciesRecursively: false,
            },
          ],
        },
      });

      // Same standalone auth chunk as the failing case above.
      expect(built.jsFiles.some((name) => name.startsWith("auth-"))).toBe(true);

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* deployPrebuilt(
            "DrizzleSchemaChunksStrictOrder",
            built.main,
          );
        }),
      );

      expect(worker.url).toBeDefined();
      const client = yield* HttpClient.HttpClient;
      const body = yield* client.get(worker.url!).pipe(
        Effect.flatMap((res) => res.text),
        Effect.repeat({
          schedule: Schedule.exponential("500 millis"),
          until: (b) => b.includes('"ok":true'),
          times: 10,
        }),
        Effect.orDie,
      );
      expect(body).toContain('"ok":true');

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "Cloudflare accepts the same Worker when drizzle-orm is grouped with schema modules (#749 workaround)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const built = yield* buildWorkerLike({
        id: "drizzle-schema-chunks-together",
        codeSplitting: {
          groups: [
            {
              name: "drizzle-auth-schema",
              test: (id) => /drizzle-orm/.test(id) || schemaModuleTest.test(id),
              includeDependenciesRecursively: false,
            },
          ],
        },
      });

      expect(
        built.jsFiles.some((name) => name.startsWith("drizzle-auth-schema-")),
      ).toBe(true);
      expect(built.jsFiles.some((name) => name.startsWith("auth-"))).toBe(
        false,
      );

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* deployPrebuilt(
            "DrizzleSchemaChunksTogether",
            built.main,
          );
        }),
      );

      expect(worker.url).toBeDefined();
      const client = yield* HttpClient.HttpClient;
      // Fresh workers.dev URLs can serve placeholder HTML while propagating —
      // poll until the fixture's JSON marker appears.
      const body = yield* client.get(worker.url!).pipe(
        Effect.flatMap((res) => res.text),
        Effect.repeat({
          schedule: Schedule.exponential("500 millis"),
          until: (b) => b.includes('"ok":true'),
          times: 10,
        }),
        Effect.orDie,
      );
      expect(body).toContain('"ok":true');

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
