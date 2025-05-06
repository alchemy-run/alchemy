import fs from "node:fs/promises";
import { Bundle } from "../../esbuild/bundle.js";
import type { Bindings } from "../bindings.js";
import type { WorkerProps } from "../worker.js";
import { createAliasPlugin } from "./alias-plugin.js";
import {
  isBuildFailure,
  rewriteNodeCompatBuildFailure,
} from "./build-failures.js";
import { external, external_als } from "./external.js";
import { getNodeJSCompatMode } from "./nodejs-compat-mode.js";
import { nodeJsCompatPlugin } from "./nodejs-compat.js";

export async function bundleWorkerScript<B extends Bindings>(
  props: WorkerProps<B> & {
    compatibilityDate: string;
    compatibilityFlags: string[];
  },
) {
  const projectRoot = props.projectRoot ?? process.cwd();

  const nodeJsCompatMode = getNodeJSCompatMode(
    props.compatibilityDate,
    props.compatibilityFlags,
  );

  if (nodeJsCompatMode === "v1") {
    throw new Error(
      "You must set your compatibilty date >= 2024-09-23 when using 'nodejs_compat' compatibility flag",
    );
  }

  try {
    const bundle = await Bundle("bundle", {
      entryPoint: props.entrypoint!,
      format: props.format === "cjs" ? "cjs" : "esm", // Use the specified format or default to ESM
      target: "esnext",
      platform: "node",
      minify: false,
      ...(props.bundle || {}),
      conditions: ["workerd", "worker", "browser"],
      options: {
        absWorkingDir: projectRoot,
        ...(props.bundle?.options || {}),
        keepNames: true, // Important for Durable Object classes
        loader: {
          ".sql": "text",
          ".json": "json",
        },
        plugins: [
          ...(nodeJsCompatMode === "v2" ? [await nodeJsCompatPlugin()] : []),
          ...(props.bundle?.alias
            ? [
                createAliasPlugin({
                  alias: props.bundle?.alias,
                  projectRoot,
                }),
              ]
            : []),
        ],
      },
      external: [
        ...(nodeJsCompatMode === "als" ? external_als : external),
        ...(props.bundle?.external ?? []),
        ...(props.bundle?.options?.external ?? []),
      ],
    });
    if (bundle.content) {
      return bundle.content;
    }
    if (bundle.path) {
      return await fs.readFile(bundle.path, "utf-8");
    }
    throw new Error("Failed to create bundle");
  } catch (e: any) {
    if (e.message?.includes("No such module 'node:")) {
      throw new Error(
        `${e.message}.\nMake sure to set 'nodejs_compat' compatibility flag and compatibilityDate > 2024-09-23`,
        { cause: e },
      );
    }
    if (isBuildFailure(e)) {
      rewriteNodeCompatBuildFailure(e.errors, nodeJsCompatMode);
      throw e;
    }
    console.error("Error reading bundle:", e);
    throw new Error("Error reading bundle");
  }
}
