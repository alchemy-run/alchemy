import cloudflareRolldown from "@distilled.cloud/cloudflare-rolldown-plugin";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { fileURLToPath } from "node:url";
import type * as rolldown from "rolldown";
import Sonda from "sonda/rolldown";
import * as Artifacts from "../../Artifacts.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../Bundle/TempRoot.ts";
import { Self } from "../../Self.ts";
import {
  isDurableObjectExport,
  type DurableObjectExport,
} from "./DurableObjectNamespace.ts";
import type { WorkerProps } from "./Worker.ts";
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
  userOptions: WorkerProps["build"] | undefined;
}

export const WorkerBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const makeOptions = Effect.fnUntraced(function* (
    options: WorkerBundleOptions,
  ) {
    const realMain = yield* sanitizeMain(options.main);
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
        ...(options.userOptions?.metafile ? [Sonda({ open: false })] : []),
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
    const extraOptions: Bundle.BundleExtraOptions = {
      pure: options.userOptions?.pure,
    };
    return { inputOptions, outputOptions, extraOptions };
  });

  const sanitizeMain = (main: string) =>
    Effect.sync(() => {
      try {
        return fileURLToPath(main);
      } catch {
        return main;
      }
    }).pipe(
      Effect.flatMap((path) => fs.realPath(path)),
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
      Artifacts.cached("build"),
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
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";

import { env, DurableObject, WorkerEntrypoint${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { MinimumLogLevel } from "effect/References";
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy/Stack";
import { WorkerEnvironment, makeDurableObjectBridge, makeWorkerBridge${hasWfClasses ? ", makeWorkflowBridge" : ""}, ExportedHandlerMethods } from "alchemy/Cloudflare";

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
  Effect.flatMap(func => func.RuntimeContext.exports),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
            ConfigProvider.fromUnknown(env),
          ),
        ),
      ),
      Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
      Layer.provideMerge(
        Layer.succeed(MinimumLogLevel, env.DEBUG ? "Debug" : "Info"),
      ),
    ),
  ),
  Effect.scoped,
);

// TODO(sam): we could kick this off during module init, but any I/O will break deploy
// let exportsPromise = Effect.runPromise(exportsEffect);

// for now, we delay initializing the worker until the first request
let exportsPromise;

// don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
// we cache it synchronously (??=) to guarnatee only one initialization ever happens
const getExports = () => (exportsPromise ??= Effect.runPromise(exportsEffect))
const getExport = (name) => getExports().then(exports => exports[name]?.make)
const getDefault = () => getExports().then(exports => exports.default)
const getRpc = () => getExports().then(exports => exports.__rpc__ ?? {})

// Bridge the user's default-export shape onto a real \`WorkerEntrypoint\`
// subclass so Cloudflare service bindings can dispatch both the standard
// handler methods (fetch, scheduled, …) and any user-defined RPC methods.
// RPC method results are wire-encoded by \`runtimeContext.exports\`;
// consumers unwrap them with \`Cloudflare.toPromiseApi(env.X)\` (Promise
// API) or \`bindWorker(WorkerClass)\` (Effect API).
export default makeWorkerBridge(
  WorkerEntrypoint,
  ExportedHandlerMethods,
  getDefault,
  getRpc,
);

// export class proxy stubs for Durable Objects and Workflows
${[
  ...(hasDoClasses
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, getExport);",
        ...doClasses.map(
          (id) => `export class ${id} extends DurableObjectBridge("${id}") {}`,
        ),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, getExport);",
        ...wfClasses.map(
          (id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`,
        ),
      ]
    : []),
].join("\n")}
`;
};
