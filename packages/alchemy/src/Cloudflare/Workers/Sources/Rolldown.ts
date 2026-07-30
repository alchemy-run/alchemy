import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { builtinModules } from "node:module";
import path from "pathe";
import type * as rolldown from "rolldown";
import * as Artifacts from "../../../Artifacts.ts";
import * as Bundle from "../../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../../Bundle/TempRoot.ts";
import {
  isWorkflowExport,
  type WorkflowExport,
} from "../../Workflows/Workflow.ts";
import {
  isDurableObjectExport,
  type DurableObjectExport,
} from "../DurableObject.ts";
import type {
  SourceContext,
  SourceDevHandle,
  SourceProvider,
} from "../Source.ts";
import { mainToPath } from "./shared.ts";

/**
 * Node builtin specifiers, prefixed or not — the same shape the cloudflare
 * rolldown plugin matches (its vite half uses an identical regex for the
 * deps-optimizer `esmExternalRequirePlugin` registration).
 */
const NODE_BUILTIN_MODULES_REGEXP = new RegExp(
  `^(${builtinModules.filter((name) => !name.startsWith("node:")).join("|")}|node:.+)$`,
);

/**
 * Bundler options for a Worker: the generic {@link Bundle.BundleExtraOptions}
 * plus rolldown output overrides merged over Alchemy's defaults.
 */
export interface WorkerBuildOptions extends Bundle.BundleExtraOptions {
  /**
   * Rolldown output options merged over Alchemy's defaults. Use this to
   * control chunking (`codeSplitting`), minification, etc.
   */
  output?: rolldown.OutputOptions;
  /**
   * Forwarded to rolldown's `preserveEntrySignatures` input option. Some
   * `output.codeSplitting` configurations require relaxing it (e.g.
   * `includeDependenciesRecursively: false` needs `"allow-extension"`).
   * Workers must keep their entry exports, so never pass `false`.
   */
  preserveEntrySignatures?: rolldown.InputOptions["preserveEntrySignatures"];
}

export interface WorkerBundleOptions {
  id: string;
  main: string;
  compatibility: {
    date: string;
    flags: string[];
  };
  entry:
    | {
        kind: "external";
      }
    | {
        kind: "effect";
        exports: Record<string, DurableObjectExport | WorkflowExport>;
      };
  stack: { name: string; stage: string };
  extraOptions: WorkerBuildOptions | undefined;
}

export const WorkerBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const makeOptions = Effect.fn(function* (options: WorkerBundleOptions) {
    // Loaded lazily so importing the Cloudflare provider (or the CLI, whose
    // command tree reaches this module) never loads rolldown's native
    // binding — only actually bundling a Worker does (#562).
    const [{ default: cloudflareRolldown }, { esmExternalRequirePlugin }] =
      yield* Effect.promise(() =>
        Promise.all([
          import("@distilled.cloud/cloudflare-rolldown-plugin"),
          import("rolldown/plugins"),
        ]),
      );
    const realMain = yield* sanitizeMain(options.main);
    const inputOptions: rolldown.InputOptions = {
      input: realMain,
      preserveEntrySignatures: options.extraOptions?.preserveEntrySignatures,
      // Forever-devtool native modules that vite/chokidar reference behind
      // runtime guards. Rolldown resolves before tree-shaking, so the dead
      // `require('../pkg')` (lightningcss < 1.32) and `require('fsevents')`
      // (darwin-only) trip [UNRESOLVED_IMPORT] before DCE can prune them.
      // See rolldown/tsdown#212.
      external: ["lightningcss", "fsevents"],
      cwd: yield* findCwdForBundle(realMain).pipe(
        Effect.mapError(
          (cause) =>
            new Bundle.BundleError({
              message: `Failed to find cwd for bundle: ${realMain}`,
              cause,
            }),
        ),
        Effect.provide(context),
      ),
      plugins: [
        // The cloudflare plugin injects this builtin conversion itself, but
        // constructs it from ITS OWN rolldown package instance. Rolldown
        // recognizes builtin plugins via `instanceof BuiltinPlugin`, so
        // when the plugin's `rolldown` resolves to a different install
        // than ours (dual-workspace/dual-store node_modules), its instance
        // is silently treated as a hookless JS plugin and CJS `require`s
        // of Node builtins survive into the ESM output — throwing
        // "Calling `require` for ..." at Worker startup. Inject the
        // builtin from OUR rolldown instance so the conversion always
        // applies under nodejs_compat (`skipDuplicateCheck` keeps the two
        // registrations compatible when the instances do coincide).
        options.compatibility.flags.some(
          (flag) => flag === "nodejs_compat" || flag === "nodejs_compat_v2",
        )
          ? esmExternalRequirePlugin({
              external: [NODE_BUILTIN_MODULES_REGEXP],
              skipDuplicateCheck: true,
            })
          : undefined,
        cloudflareRolldown({
          compatibilityDate: options.compatibility.date,
          compatibilityFlags: options.compatibility.flags,
        }),
        options.entry.kind === "effect"
          ? [
              virtualEntryPlugin(
                makeEffectVirtualEntry(options.entry.exports, options.stack),
              ),
            ]
          : undefined,
      ],
      checks: {
        // Suppress unresolved import warnings for unrelated AWS packages
        unresolvedImport: false,
        // Suppress warning caused by static import of `@effect/platform-node/NodeServices` in `WorkerBridge.ts`
        ineffectiveDynamicImport: false,
      },
    };
    const outputOptions: rolldown.OutputOptions = {
      format: "esm",
      sourcemap: "hidden",
      minify: true,
      keepNames: true,
      // Rolldown's default chunking can split top-level initializer modules
      // (e.g. Drizzle `pgTable` schemas) away from the classes they read,
      // and workerd then evaluates a reader before its imported binding is
      // initialized — the script fails Cloudflare startup validation with
      // `ScriptStartupError: Cannot access '<minified>' before
      // initialization` (#749). `strictExecutionOrder` wraps cross-chunk
      // modules so evaluation follows ESM semantics regardless of how the
      // graph was chunked. See DrizzleSchemaChunks.test.ts.
      strictExecutionOrder: true,
      dir: `.alchemy/bundles/${options.id}`,
      ...options.extraOptions?.output,
    };
    return { inputOptions, outputOptions, extraOptions: options.extraOptions };
  });

  const sanitizeMain = (main: string) =>
    mainToPath(main).pipe(
      Effect.flatMap((p) => fs.realPath(p)),
      //* fix windows paths
      Effect.map((p) => path.resolve(p)),
      Effect.mapError(
        (cause) =>
          new Bundle.BundleError({
            message: `Failed to find real path for bundle: ${main}`,
            cause,
          }),
      ),
    );

  return {
    build: flow(
      makeOptions,
      Effect.flatMap((resolved) =>
        Bundle.build(
          resolved.inputOptions,
          resolved.outputOptions,
          resolved.extraOptions,
        ),
      ),
    ),
    watch: flow(
      makeOptions,
      Stream.fromEffect,
      Stream.flatMap((resolved) =>
        Bundle.watch(
          resolved.inputOptions,
          resolved.outputOptions,
          resolved.extraOptions,
        ),
      ),
    ),
  };
});

export const makeEffectVirtualEntry = (
  exports: Record<string, DurableObjectExport | WorkflowExport>,
  stack: { name: string; stage: string },
) => {
  const doClasses: string[] = [];
  const wfClasses: string[] = [];
  for (const [className, entry] of Object.entries(exports)) {
    if (isDurableObjectExport(entry)) {
      doClasses.push(className);
    } else if (isWorkflowExport(entry)) {
      wfClasses.push(className);
    }
  }
  const hasDoClasses = doClasses.length > 0;
  const hasWfClasses = wfClasses.length > 0;
  return (importPath: string) => `
import * as Effect from "effect/Effect";

import { env, DurableObject, WorkerEntrypoint${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge${hasWfClasses ? ", makeWorkflowBridge" : ""} } from "alchemy/Cloudflare";
import { makeEntrypointLayer } from "alchemy/Runtime";

import entrypoint from ${JSON.stringify(importPath)};

const meta = {
  entrypoint,
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
};

export default makeWorkerBridge(WorkerEntrypoint, meta);

// export class proxy stubs for Durable Objects and Workflows
${[
  ...(hasDoClasses
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, meta);",
        ...doClasses.map(
          (id) => `export class ${id} extends DurableObjectBridge("${id}") {}`,
        ),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, meta);",
        ...wfClasses.map(
          (id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`,
        ),
      ]
    : []),
].join("\n")}
`;
};

/**
 * The default source provider: bundle `props.main` with rolldown.
 *
 * `hash()` deliberately builds — recomputing "without building" is
 * impossible for rolldown without a source-tree memo hash, and today's
 * semantics accept that. The build routes through `Artifacts.cached`
 * under the same key as `build()`, so a diff that had to build shares
 * its output with the reconcile in the same run.
 */
export const makeRolldownSource = (options: {
  main: string;
}): SourceProvider => {
  const bundleOptions = (ctx: SourceContext): WorkerBundleOptions => ({
    id: ctx.id,
    main: options.main,
    compatibility: ctx.compatibility,
    entry: ctx.entry,
    stack: ctx.stack,
    extraOptions: ctx.extraOptions,
  });
  const build = (ctx: SourceContext) =>
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;
      return yield* bundler.build(bundleOptions(ctx));
    }).pipe(Artifacts.cached("build"));
  return {
    ownsAssets: false,
    build: (ctx) =>
      build(ctx).pipe(
        Effect.map((output) => ({
          bundle: output,
          assets: undefined,
          hash: {
            bundle: output.hash,
            assets: undefined,
            input: undefined,
            additionalWorkspaces: undefined,
          },
        })),
      ),
    hash: (ctx) =>
      build(ctx).pipe(Effect.map((output) => ({ bundle: output.hash }))),
    dev: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return {
          mode: "bundle",
          bundles: bundler.watch(bundleOptions(ctx)),
        } satisfies SourceDevHandle;
      }),
  };
};
