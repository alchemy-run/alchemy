import cloudflareRolldown from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import * as Artifacts from "../../Artifacts.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../Bundle/TempRoot.ts";
import { Self } from "../../Self.ts";
import {
  isDurableObjectExport,
  type DurableObjectExport,
} from "./DurableObjectNamespace.ts";
import { isWorkflowExport, type WorkflowExport } from "./Workflow.ts";

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
}

export const WorkerBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const makeOptions = Effect.fnUntraced(function* (
    options: WorkerBundleOptions,
  ) {
    const realMain = yield* fs.realPath(options.main).pipe(
      Effect.mapError(
        (cause) =>
          new Bundle.BundleError({
            message: `Failed to find real path for bundle: ${options.main}`,
            cause,
          }),
      ),
    );
    const inputOptions: rolldown.InputOptions = {
      input: realMain,
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
        cloudflareRolldown({
          compatibilityDate: options.compatibility.date,
          compatibilityFlags: options.compatibility.flags,
        }),
        options.entry.kind === "effect"
          ? virtualEntryPlugin(
              makeEffectVirtualEntry(options.entry.exports, options.stack),
            )
          : undefined,
      ],
      checks: {
        // Suppress unresolved import warnings for unrelated AWS packages
        unresolvedImport: false,
      },
    };
    const outputOptions: rolldown.OutputOptions = {
      format: "esm",
      sourcemap: "hidden",
      minify: true,
      keepNames: true,
      dir: `.alchemy/bundles/${options.id}`,
    };
    return { inputOptions, outputOptions };
  });

  return {
    build: flow(
      makeOptions,
      Effect.flatMap((resolved) =>
        Bundle.build(resolved.inputOptions, resolved.outputOptions),
      ),
      Artifacts.cached("build"),
    ),
    watch: flow(
      makeOptions,
      Stream.fromEffect,
      Stream.flatMap((resolved) =>
        Bundle.watch(resolved.inputOptions, resolved.outputOptions),
      ),
    ),
  };
});

const makeEffectVirtualEntry = (
  exports: Record<string, DurableObjectExport | WorkflowExport>,
  stack: { name: string; stage: string },
) => {
  const durableObjectClasses: string[] = [];
  const workflowClasses: string[] = [];
  for (const [className, entry] of Object.entries(exports)) {
    if (isDurableObjectExport(entry)) {
      durableObjectClasses.push(className);
    } else if (isWorkflowExport(entry)) {
      workflowClasses.push(className);
    }
  }
  return (importPath: string) => `import * as Config from "effect/Config";
  import * as ConfigProvider from "effect/ConfigProvider";
  import * as Console from "effect/Console";
  import * as Effect from "effect/Effect";
  import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
  import * as Layer from "effect/Layer";
  import * as Logger from "effect/Logger";
  import * as Context from "effect/Context";
  import * as Stream from "effect/Stream";
  
  import { env, DurableObject${workflowClasses.length > 0 ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
  import { MinimumLogLevel } from "effect/References";
  import { NodeServices } from "@effect/platform-node";
  import { Stack } from "alchemy/Stack";
  import { WorkerEnvironment, makeDurableObjectBridge${workflowClasses.length > 0 ? ", makeWorkflowBridge" : ""}, ExportedHandlerMethods } from "alchemy/Cloudflare";
  
  import entry from "${importPath}";
  
  const tag = Context.Service("${Self.key}")
  const layer =
  typeof entry?.build === "function"
  ? entry
  : Layer.effect(tag, typeof entry?.asEffect === "function" ? entry.asEffect() : entry);
  
  const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
  );
  
  const stack = Layer.succeed(
  Stack,
  {
  name: "${stack.name}",
  stage: "${stack.stage}",
  bindings: {},
  resources: {}
  }
  );
  
  const exportsEffect = tag.asEffect().pipe(
  Effect.flatMap(func => func.ExecutionContext.exports),
  Effect.map(exports => exports),
  Effect.provide(
  layer.pipe(
  Layer.provideMerge(stack),
  // TODO(sam): additional credentials?
  Layer.provideMerge(platform),
  Layer.provideMerge(
  Layer.succeed(
    ConfigProvider.ConfigProvider,
    ConfigProvider.orElse(
      ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
      ConfigProvider.fromUnknown(env),
    ),
  )
  ),
  Layer.provideMerge(
  Layer.succeed(
    WorkerEnvironment,
    env,
  )
  ),
  Layer.provideMerge(
  Layer.succeed(
    MinimumLogLevel,
    env.DEBUG ? "Debug" : "Info",
  )
  ),
  )
  ),
  Effect.scoped
  );
  
  // TODO(sam): we could kick this off during module init, but any I/O will break deploy
  // let exportsPromise = Effect.runPromise(exportsEffect);
  
  // for now, we delay initializing the worker until the first request
  let exportsPromise;
  
  // don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
  // we cache it synchronously (??=) to guarnatee only one initialization ever happens
  const getExports = () => (exportsPromise ??= Effect.runPromise(exportsEffect))
  const getExport = (name) => getExports().then(exports => exports[name]?.make)
  const worker = () => getExports().then(exports => exports.default)
  
  export default Object.fromEntries(ExportedHandlerMethods.map(
  method => [method, async (...args) => (await worker())[method](...args)])
  ) satisfies Required<cf.ExportedHandler>;
  
  // export class proxy stubs for Durable Objects and Workflows
  ${[
    ...(durableObjectClasses.length > 0
      ? [
          "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, getExport);",
          ...durableObjectClasses.map(
            (id) =>
              `export class ${id} extends DurableObjectBridge("${id}") {}`,
          ),
        ]
      : []),
    ...(workflowClasses.length > 0
      ? [
          "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, getExport);",
          ...workflowClasses.map(
            (id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`,
          ),
        ]
      : []),
  ].join("\n")}
  `;
};
