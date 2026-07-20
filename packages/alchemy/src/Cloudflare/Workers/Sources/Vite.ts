import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { hashDirectory, type MemoOptions } from "../../../Command/Memo.ts";
import { sha256Object } from "../../../Util/sha256.ts";
import { readAssets } from "../Assets.ts";
import type { SourceDevHandle, SourceProvider } from "../Source.ts";
import type { ViteOptions } from "../Worker.ts";
import { isWorkerLoader } from "../WorkerLoader.ts";

/**
 * Resolve `props.env` to the literal values vite's `import.meta.env`
 * defines are computed from: strings pass through, `Redacted<string>`s
 * are unwrapped, env-bound Effects are evaluated, and `WorkerLoader`s
 * (bindings that happen to be Effects) are skipped.
 */
const resolveViteEnv = (env: Record<string, unknown>) =>
  Effect.gen(function* () {
    return Object.fromEntries(
      (yield* Effect.all(
        Object.entries(env).map(
          Effect.fn(function* ([key, value]) {
            return [
              key,
              typeof value === "string"
                ? value
                : Redacted.isRedacted(value) &&
                    typeof Redacted.value(value) === "string"
                  ? Redacted.value(value)
                  : // A `WorkerLoader` is a real Effect that also carries
                    // the `~alchemy/Kind` marker — it is a binding, not a
                    // runnable env value. Check it before `Effect.isEffect`
                    // so we don't execute it as an inlined env entry.
                    isWorkerLoader(value)
                    ? undefined
                    : Effect.isEffect(value)
                      ? yield* value as any as Effect.Effect<any>
                      : undefined,
            ];
          }),
        ),
      )).filter(([_, value]) => value !== undefined),
    );
  });

/**
 * Hash the vite project's input tree (root + workspaces + lockfiles) —
 * the rebuild-free change signal for the `input` hash slot.
 */
export const hashViteInput = Effect.fn(function* <E, R>(
  rootDir: string = process.cwd(),
  options: ViteOptions["memo"],
  additionalWorkspaces: Effect.Effect<Iterable<string>, E, R>,
) {
  const path = yield* Path.Path;
  const hashWorkspaceDirectory = (cwd: string, memo?: MemoOptions) =>
    hashDirectory({ cwd: path.resolve(rootDir, cwd), memo }).pipe(
      Effect.map((hash) => `${path.relative(rootDir, cwd)}:${hash}`),
    );
  const hashRoot = hashWorkspaceDirectory(rootDir, options);
  if (Array.isArray(options?.workspaces)) {
    return yield* Effect.all(
      [
        hashRoot,
        ...options.workspaces.map(({ cwd, ...options }) =>
          hashWorkspaceDirectory(cwd, options),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(([root, ...workspaces]) =>
        sha256Object([root, ...workspaces.sort()]),
      ),
      Effect.map((hash) => ({ hash, workspaces: undefined })),
    );
  }
  const [root, workspaces] = yield* Effect.all(
    [hashRoot, additionalWorkspaces],
    { concurrency: "unbounded" },
  );
  const workspaceHashes = yield* Effect.forEach(
    workspaces,
    (cwd) => hashWorkspaceDirectory(cwd),
    { concurrency: "unbounded" },
  );
  const hash = yield* sha256Object([root, ...workspaceHashes.sort()]);
  return {
    hash,
    workspaces: Array.from(workspaces).map((cwd) =>
      path.relative(rootDir, cwd),
    ),
  };
});

/**
 * Source provider for vite-based workers (`props.vite`, set by
 * `Website.Vite`): the vite builder produces the client assets and the
 * server bundle in one pass; diff never builds — the `input` hash over
 * the project tree is the change signal.
 *
 * The heavy `../Vite.ts` module (which pulls in
 * `@distilled.cloud/cloudflare-vite-plugin`, ~0.5s) is loaded lazily
 * inside `build()`/`dev()` so its module cost stays off the hot path.
 */
export const makeViteSource = (vite: ViteOptions): SourceProvider => ({
  ownsAssets: true,
  build: Effect.fn(function* (ctx) {
    const path = yield* Path.Path;
    // Loaded lazily: `../Vite.ts` pulls in `@distilled.cloud/cloudflare-vite-plugin`
    // (~0.5s), which is only needed for vite-based workers at build time —
    // not for every Worker definition at module-load time.
    const Vite = yield* Effect.promise(() => import("../Vite.ts"));
    const env = yield* resolveViteEnv(ctx.env ?? {});
    const { clientDirectory, serverBundle, externalWorkspaces } =
      yield* Vite.viteBuild(vite.rootDir, env, {
        main: vite.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
      });
    const [assets, bundle, input] = yield* Effect.all(
      [
        clientDirectory
          ? readAssets({
              ...(ctx.assets && typeof ctx.assets !== "string"
                ? ctx.assets
                : undefined),
              directory: path.resolve(
                vite.rootDir ?? process.cwd(),
                clientDirectory,
              ),
            })
          : Effect.undefined,
        serverBundle,
        hashViteInput(vite.rootDir, vite.memo, externalWorkspaces),
      ],
      { concurrency: "unbounded" },
    );
    if (!assets && !bundle) {
      return yield* Effect.die(
        new Error("Vite build produced neither assets nor server output"),
      );
    }
    return {
      bundle,
      assets,
      hash: {
        bundle: bundle?.hash,
        assets: assets?.hash,
        input: input.hash,
        additionalWorkspaces: input.workspaces,
      },
    };
  }),
  hash: Effect.fn(function* (_ctx, previous) {
    const { hash, workspaces } = yield* hashViteInput(
      vite.rootDir,
      vite.memo,
      Effect.succeed(previous?.additionalWorkspaces ?? []),
    );
    return { input: hash, additionalWorkspaces: workspaces };
  }),
  dev: Effect.fn(function* (ctx) {
    // Loaded lazily: `../Vite.ts` pulls in `@distilled.cloud/cloudflare-vite-plugin`
    // (~0.5s); only needed when running a vite dev server.
    const Vite = yield* Effect.promise(() => import("../Vite.ts"));
    const devServer = yield* Vite.viteDev(
      vite.rootDir,
      ctx.env ?? {},
      {
        main: vite.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
        worker: {
          name: ctx.worker.name,
          bindings: ctx.worker.bindings,
          durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
          hyperdrives: ctx.worker.hyperdrives,
          queueConsumers: yield* ctx.worker.queueConsumers,
          assets: ctx.worker.assets,
        },
        context: ctx.runtimeContext,
      },
      { port: 0 },
    );
    return {
      mode: "server",
      url: new URL(devServer.resolvedUrls!.local[0]),
    } satisfies SourceDevHandle;
  }),
});
