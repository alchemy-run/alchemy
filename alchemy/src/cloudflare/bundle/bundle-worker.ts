import fs from "node:fs/promises";
import path from "node:path";
import { Bundle } from "../../esbuild/bundle.ts";
import { getContentType } from "../../util/content-type.ts";
import type { Bindings } from "../bindings.ts";
import type { WorkerProps } from "../worker.ts";
import { createAliasPlugin } from "./alias-plugin.ts";
import {
    isBuildFailure,
    rewriteNodeCompatBuildFailure,
} from "./build-failures.ts";
import { external, external_als } from "./external.ts";
import { getNodeJSCompatMode } from "./nodejs-compat-mode.ts";
import { nodeJsCompatPlugin } from "./nodejs-compat.ts";
import { wasmPlugin } from "./wasm-plugin.ts";

/**
 * Unified interface for all worker file collections
 * Represents both bundled and non-bundled worker deployments
 */
export interface WorkerFiles {
  /**
   * Collection of files to deploy
   * Key: filename, Value: file content and metadata
   */
  files: {
    [fileName: string]: {
      content: string | Buffer;
      contentType?: string;
    };
  };
  
  /**
   * The main entry file for the worker
   * Must be one of the keys in the files object
   */
  mainFile: string;
  
  /**
   * Optional source map information
   */
  sourceMap?: {
    name: string;
    content: string;
  };
}

/**
 * Legacy type for backward compatibility
 * @deprecated Use WorkerFiles instead
 */
export type NoBundleResult = {
  [fileName: string]: Buffer;
};

/**
 * Legacy interface for backward compatibility
 * @deprecated Use WorkerFiles instead
 */
export interface BundledWorkerScript {
  scriptName: string;
  scriptContent: string;
  sourceMap?: {
    name: string;
    content: string;
  };
}

/**
 * The output of the worker script bundling process.
 * Now consistently uses WorkerFiles interface for all scenarios.
 */
export type WorkerScriptOutput = WorkerFiles;

export type BundleResult = WorkerFiles;

export async function bundleWorkerScript<B extends Bindings>(
  props: WorkerProps<B> & {
    entrypoint: string;
    compatibilityDate: string;
    compatibilityFlags: string[];
  },
): Promise<WorkerScriptOutput> {
  const projectRoot = props.projectRoot ?? process.cwd();

  const nodeJsCompatMode = await getNodeJSCompatMode(
    props.compatibilityDate,
    props.compatibilityFlags,
  );

  if (nodeJsCompatMode === "v1") {
    throw new Error(
      "You must set your compatibilty date >= 2024-09-23 when using 'nodejs_compat' compatibility flag",
    );
  }
  const main = props.entrypoint;

  if (props.noBundle) {
    const rootDir = path.dirname(path.resolve(main));
    
    // Enhanced glob patterns to include source maps automatically
    const defaultRules = [
      {
        globs: ["**/*.js", "**/*.mjs", "**/*.wasm", "**/*.map"], // Include .map files
      },
    ];
    
    const rules = (props.rules ?? defaultRules).flatMap((rule) => rule.globs);
    const files = Array.from(
      new Set(
        (
          await Promise.all(
            rules.map((rule) =>
              Array.fromAsync(
                fs.glob(rule, {
                  cwd: rootDir,
                }),
              ),
            ),
          )
        ).flat(),
      ),
    );
    
    // Separate source map files from regular files
    const sourceMapFiles = files.filter(file => file.endsWith('.map'));
    const regularFiles = files.filter(file => !file.endsWith('.map'));
    
    // Convert to unified WorkerFiles format
    const fileEntries = await Promise.all(
      regularFiles.map(async (file) => [
        file,
        {
          content: await fs.readFile(path.resolve(rootDir, file)),
          contentType: getContentTypeForFile(file),
        },
      ]),
    );

    const mainFile = path.basename(main);
    
    // Find source map for the main file if it exists
    let mainSourceMap: { name: string; content: string } | undefined;
    const mainFileSourceMapName = `${mainFile}.map`;
    const mainFileSourceMap = sourceMapFiles.find(mapFile => 
      path.basename(mapFile) === mainFileSourceMapName
    );
    
    if (mainFileSourceMap) {
      try {
        const sourceMapContent = await fs.readFile(path.resolve(rootDir, mainFileSourceMap), 'utf-8');
        mainSourceMap = {
          name: mainFileSourceMapName,
          content: sourceMapContent,
        };
      } catch (error) {
        // Source map file exists but can't be read - log warning but continue
        console.warn(`Found source map ${mainFileSourceMap} but failed to read it:`, error);
      }
    }
    
    return {
      files: Object.fromEntries(fileEntries),
      mainFile,
      sourceMap: mainSourceMap,
    };
  }

  try {
    const entryPointBaseName = path.basename(main, path.extname(main));
    const outfileName = `${entryPointBaseName}.js`;

    const bundleResult = await Bundle("bundle", {
      entryPoint: main,
      outfile: outfileName,
      format: props.format === "cjs" ? "cjs" : "esm",
      target: "esnext",
      platform: "node",
      minify: props.bundle?.minify ?? false,
      ...(props.bundle || {}),
      sourcemap: props.bundle?.sourcemap === "inline" ? "inline" : undefined,
      conditions: ["workerd", "worker", "browser"],
      absWorkingDir: projectRoot,
      keepNames: true,
      loader: {
        ".sql": "text",
        ".json": "json",
        ...props.bundle?.loader,
      },
      plugins: [
        wasmPlugin,
        ...(props.bundle?.plugins ?? []),
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
      external: [
        ...(nodeJsCompatMode === "als" ? external_als : external),
        ...(props.bundle?.external ?? []),
      ],
      write: false,
    });

    if (!bundleResult.content) {
      throw new Error("Failed to create bundle: no content.");
    }

    // Use consistent script name - always use "_worker.js" for bundled workers
    const scriptName = "_worker.js";

    // Convert to unified WorkerFiles format
    return {
      files: {
        [scriptName]: {
          content: bundleResult.content,
          contentType: "application/javascript",
        },
      },
      mainFile: scriptName,
    };
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

/**
 * Get appropriate content type for a file based on its extension
 * Uses the existing getContentType utility with fallback
 */
function getContentTypeForFile(fileName: string): string {
  return getContentType(fileName) ?? 'application/octet-stream';
}
