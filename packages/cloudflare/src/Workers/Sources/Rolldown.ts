import { stripVTControlCharacters } from "node:util";
import type { AdditionalModuleRule } from "@alchemy.run/cloudflare-runtime/rolldown/options";
import * as Artifacts from "alchemy/Artifacts";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Shared from "alchemy/Workers/Workerd/Bundle";
import * as Effect from "effect/Effect";
import path from "pathe";
import picomatch from "picomatch";
import { isWorkflowExport } from "../../Workflows/Workflow.ts";
import { isDurableObjectExport } from "../DurableObject.ts";
import type { SourceContext, SourceProvider } from "../Source.ts";
import type { SqlMigrationSnapshot } from "../SqlMigrationsRuntime.ts";
import type { WorkerProps } from "../Worker.ts";
import type { WorkerExport } from "../WorkerRuntimeContext.ts";
import type { ModuleRule } from "./Prebuilt.ts";
import { bundleSource } from "./shared.ts";

export type { WorkerBuildOptions } from "alchemy/Workers/Workerd/Bundle";

export interface WorkerBundleOptions extends Omit<Shared.WorkerBundleOptions, "entry"> {
  entry:
    | {
        kind: "external";
      }
    | {
        kind: "effect";
        exports: Record<string, WorkerExport>;
      };
  rules?: readonly ModuleRule[] | undefined;
}

/**
 * The bundler options for a Worker's props, as local dev records them in its
 * hashed config (a change restarts the instance). Builds themselves go
 * through the Worker's source provider (`resolveSource`), which derives the
 * same options from its {@link SourceContext} in {@link makeRolldownSource}.
 */
export const workerBundleOptions = (options: {
  id: string;
  props: Pick<WorkerProps, "main" | "isExternal" | "exports" | "build" | "rules">;
  compatibility: WorkerBundleOptions["compatibility"];
  stack: WorkerBundleOptions["stack"];
}): WorkerBundleOptions => ({
  id: options.id,
  main: options.props.main!,
  compatibility: options.compatibility,
  entry: options.props.isExternal
    ? { kind: "external" }
    : { kind: "effect", exports: options.props.exports ?? {} },
  stack: options.stack,
  extraOptions: options.props.build,
  rules: options.props.rules,
});

/**
 * Lower the Worker's `rules` to bundler module rules: an import whose
 * resolved file matches a rule's glob is emitted as its own module, of the
 * rule's type, instead of being loaded by rolldown. Globs match the path
 * relative to the entry's directory (`../` included), or an absolute path;
 * `!` globs exclude across all user rules, as in the prebuilt
 * (`bundle: false`) walk. JavaScript, TypeScript and JSON are always bundled.
 */
const toModuleRules = (main: string, rules: readonly ModuleRule[] | undefined) => {
  const globs = rules?.flatMap((rule) => rule.globs) ?? [];
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const root = path.dirname(main);
  const isExcluded = exclude.length ? picomatch(exclude, { dot: true }) : () => false;
  // Absolute globs match any file; relative ones match from the entry's
  // directory (`../shared/*.png` too), and `**` globs from the filesystem
  // root for files outside it.
  const targetsOf = (id: string) => {
    const file = path.normalize(id);
    const relative = path.relative(root, file);
    const outside = relative.startsWith("../") || path.isAbsolute(relative);
    return outside ? [file, relative, file.replace(/^\//, "")] : [file, relative];
  };
  const moduleRules = (rules ?? []).flatMap((rule) => {
    const include = rule.globs.filter((glob) => !glob.startsWith("!"));
    if (include.length === 0) return [];
    const isIncluded = picomatch(include, { dot: true });
    return [
      {
        type: rule.type,
        test: (id: string) => {
          if (/\.([cm]?[jt]sx?|json)$/.test(id)) return false;
          const targets = targetsOf(id);
          return (
            targets.some((target) => isIncluded(target)) &&
            !targets.some((target) => isExcluded(target))
          );
        },
      },
    ];
  });
  return moduleRules.length ? moduleRules : undefined;
};

/**
 * Point rolldown's failure to load an imported non-JavaScript file (a font,
 * markdown, an image) at the `rules` that upload it as a module. A text file
 * that happens to parse as JavaScript fails later, without a default export.
 */
const withRulesHint = (error: Bundle.BundleError): Bundle.BundleError => {
  const errors = (
    error.cause as { errors?: Array<{ code?: string; id?: string; message?: string }> }
  )?.errors;
  const exts = (errors ?? []).flatMap((e) => {
    const message = e.message ? stripVTControlCharacters(e.message) : "";
    const file =
      e.code === "UNLOADABLE_DEPENDENCY"
        ? message.match(/Could not load (\S+)/)?.[1]
        : e.code === "PARSE_ERROR"
          ? e.id
          : e.code === "MISSING_EXPORT"
            ? message.match(/"default" is not exported by "([^"]+)"/)?.[1]
            : undefined;
    const ext = file && path.extname(file);
    return ext && !/^\.([cm]?[jt]sx?|json|css)$/.test(ext) ? [ext] : [];
  });
  if (exts.length === 0) return error;
  const unique = [...new Set(exts)];
  const isText = (ext: string) => TEXT_EXTENSIONS.test(ext);
  const rules = [
    { type: "Text", exts: unique.filter(isText) },
    { type: "Data", exts: unique.filter((ext) => !isText(ext)) },
  ]
    .filter((rule) => rule.exts.length)
    .map(
      (rule) =>
        `{ type: "${rule.type}", globs: [${rule.exts.map((ext) => `"**/*${ext}"`).join(", ")}] }`,
    );
  return Bundle.BundleError.make({
    message: `${error.message}\nTo import these files as Worker modules, add rules: [${rules.join(", ")}] to the Worker.`,
    cause: error.cause,
  });
};

/** Extensions the hint suggests importing as `Text` rather than `Data`. */
const TEXT_EXTENSIONS =
  /^\.(md|markdown|mdx|csv|tsv|ya?ml|toml|ini|xml|svg|graphql|gql|glsl|wgsl|vert|frag|prompt)$/;

export const WorkerBundle = Shared.makeWorkerBundle<WorkerBundleOptions, AdditionalModuleRule>({
  // Loaded lazily so importing the Cloudflare provider (or the CLI, whose
  // command tree reaches this module) never loads rolldown's native
  // binding — only actually bundling a Worker does (#562).
  loadCompatPlugins: () =>
    import("@alchemy.run/cloudflare-runtime/rolldown").then((module) => module.default),
  virtualEntry: (options) =>
    options.entry.kind === "effect"
      ? makeEffectVirtualEntry(options.entry.exports, options.stack)
      : undefined,
  moduleRules: (options, main) => toModuleRules(main, options.rules),
  mapError: withRulesHint,
});

export const makeEffectVirtualEntry = (
  exports: Record<string, WorkerExport>,
  stack: { name: string; stage: string },
) => {
  const doClasses: string[] = [];
  const wfClasses: string[] = [];
  const migrations: Record<string, SqlMigrationSnapshot> = {};
  for (const [className, entry] of Object.entries(exports)) {
    if (isDurableObjectExport(entry)) {
      doClasses.push(className);
    } else if (isWorkflowExport(entry)) {
      wfClasses.push(className);
    } else if (entry.kind === "sqlMigrations") {
      migrations[className] = entry.snapshot;
    }
  }
  const hasMigrations = Object.keys(migrations).length > 0;
  const hasDoClasses = doClasses.length > 0;
  const hasWfClasses = wfClasses.length > 0;
  return (importPath: string) => `
import * as Effect from "effect/Effect";

import { env, DurableObject, WorkerEntrypoint${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge${hasWfClasses ? ", makeWorkflowBridge" : ""}${hasMigrations ? ", withSqlMigrations" : ""} } from "@alchemy.run/cloudflare/Bridge";
import { makeEntrypointLayer } from "alchemy/Runtime";

import entrypoint from ${JSON.stringify(importPath)};

const meta = {
  entrypoint: ${hasMigrations ? `withSqlMigrations(entrypoint, ${JSON.stringify(migrations)})` : "entrypoint"},
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
        ...doClasses.map((id) => `export class ${id} extends DurableObjectBridge("${id}") {}`),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, meta);",
        ...wfClasses.map((id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`),
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
  rules: readonly ModuleRule[] | undefined;
}): SourceProvider => {
  const bundleOptions = (ctx: SourceContext): WorkerBundleOptions => ({
    id: ctx.id,
    main: options.main,
    compatibility: ctx.compatibility,
    entry: ctx.entry,
    stack: ctx.stack,
    extraOptions: ctx.extraOptions,
    rules: options.rules,
  });
  return bundleSource({
    build: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return yield* bundler.build(bundleOptions(ctx));
      }).pipe(Artifacts.cached("build")),
    watch: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return bundler.watch(bundleOptions(ctx));
      }),
  });
};
