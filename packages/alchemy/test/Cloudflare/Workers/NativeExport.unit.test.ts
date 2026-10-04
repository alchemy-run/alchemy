import { virtualEntryPlugin } from "@/Bundle/Bundle";
import { nativeExport } from "@/Cloudflare/Workers/NativeExport.ts";
import {
  makeEffectVirtualEntry,
  validateNativeExports,
} from "@/Cloudflare/Workers/Sources/Rolldown.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerExport,
} from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

const capturedExports = Effect.fn(function* (native: Record<string, string>) {
  const worker = makeWorkerRuntimeContext("native-export-unit");
  for (const [className, module] of Object.entries(native)) {
    yield* worker.export(className, nativeExport(module));
  }
  const { default: _default, ...exports } = yield* worker.exports;
  const workerExports: Record<string, WorkerExport> = exports;
  return workerExports;
});

const entryExports = Effect.fn(function* (
  exports: Record<string, WorkerExport>,
) {
  const path = yield* Path.Path;
  const packageRoot = yield* path.fromFileUrl(
    new URL("../../../", import.meta.url),
  );
  const main = path.join(
    packageRoot,
    "test/Cloudflare/Workers/fixtures/runtime-entry/worker.ts",
  );
  const { default: cloudflare } = yield* Effect.promise(
    () => import("@alchemy.run/cloudflare-runtime/rolldown"),
  );
  const { rolldown } = yield* Effect.promise(() => import("rolldown"));
  const virtualEntry = yield* virtualEntryPlugin;
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      rolldown({
        input: main,
        cwd: packageRoot,
        external: ["lightningcss", "fsevents", main],
        plugins: [
          cloudflare({
            compatibilityDate: "2025-04-01",
            compatibilityFlags: ["nodejs_compat"],
          }),
          virtualEntry(
            makeEffectVirtualEntry(exports, {
              name: "native-export",
              stage: "test",
            }),
          ),
        ],
        checks: { unresolvedImport: false, ineffectiveDynamicImport: false },
        logLevel: "silent",
      }),
    ),
    (bundle) =>
      Effect.tryPromise(() => bundle.generate({ format: "esm" })).pipe(
        Effect.map(({ output }) =>
          output.flatMap((item) =>
            item.type === "chunk" && item.isEntry ? item.exports : [],
          ),
        ),
      ),
    (bundle) => Effect.promise(() => bundle.close()),
  );
});

layer(NodeServices.layer)("Cloudflare.Workers.nativeExport", (it) => {
  it.effect(
    "re-exports a native class from the Effect Worker's generated entry",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sandbox = path.join(
          yield* path.fromFileUrl(
            new URL("./fixtures/native-export/", import.meta.url),
          ),
          "sandbox.ts",
        );
        const exports = yield* capturedExports({
          Sandbox: sandbox,
          RepoProxy: sandbox,
        });
        expect((yield* entryExports(exports)).toSorted()).toEqual([
          "RepoProxy",
          "Sandbox",
          "default",
        ]);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker"] },
  );

  it.effect(
    "fails the build when a native export's module cannot be resolved",
    () =>
      Effect.gen(function* () {
        const exports = yield* capturedExports({
          Sandbox: "@alchemy-native-export-test/missing",
        });
        const error = yield* Effect.flip(entryExports(exports));
        expect(String(error.cause)).toContain(
          "@alchemy-native-export-test/missing",
        );
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker"] },
  );

  it.effect(
    "re-exports a native class from a bare package specifier",
    () =>
      Effect.gen(function* () {
        const exports = yield* capturedExports({
          Container: "@cloudflare/containers",
        });
        expect((yield* entryExports(exports)).toSorted()).toEqual([
          "Container",
          "default",
        ]);
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker"] },
  );

  it.effect(
    "rejects a relative module as a typed build error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          validateNativeExports({
            Sandbox: nativeExport("./sandbox.ts"),
          }),
        );
        expect(error._tag).toBe("BundleError");
      }),
    { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker"] },
  );
});
