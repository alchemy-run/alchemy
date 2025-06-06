import type esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

/**
 * Properties for creating or updating an esbuild bundle
 */
export interface BundleProps extends Partial<esbuild.BuildOptions> {
  /**
   * Entry point for the bundle
   * Path to the source file to bundle (e.g., "src/handler.ts")
   */
  entryPoint: string;

  /**
   * Output directory for the bundle
   * Directory where the bundled file will be written
   */
  outdir?: string;

  /**
   * Output filename for the bundle
   * Full path to the output file, overrides outdir if specified
   */
  outfile?: string;

  /**
   * Bundle format
   * iife: Immediately Invoked Function Expression
   * cjs: CommonJS
   * esm: ECMAScript Modules
   */
  format?: "iife" | "cjs" | "esm";

  /**
   * Target environment
   * Examples: 'node16', 'node18', 'es2020'
   */
  target?: string | string[];

  /**
   * Whether to minify the output
   */
  minify?: boolean;

  /**
   * Whether to generate sourcemaps
   * inline: Include sourcemap in bundle
   * external: Generate separate .map file
   * both: Generate both inline and external
   */
  sourcemap?: boolean | "inline" | "external" | "both";

  /**
   * External packages to exclude from bundle
   * Array of package names to mark as external
   */
  external?: string[];

  /**
   * Platform to target
   * browser: Browser environment
   * node: Node.js environment
   * neutral: Platform-agnostic
   */
  platform?: "browser" | "node" | "neutral";
}

/**
 * Describes the output of the bundling process, including optional source map.
 */
export interface BundleOutput {
  /**
   * Path to the main bundled file (if written to disk)
   * Absolute or relative path to the generated bundle
   */
  path?: string;

  /**
   * SHA-256 hash of the bundle contents
   * Used for cache busting and content verification
   */
  hash: string;

  /**
   * The content of the bundle (the .js or .mjs file)
   */
  content: string;

  /**
   * Details of the generated source map, if any.
   */
  sourceMap?: {
    /**
     * Path to the .map file (if written to disk and `props.write` was true)
     */
    path?: string;
    /**
     * Filename of the .map file (e.g., "index.js.map")
     */
    name: string;
    /**
     * Content of the .map file
     */
    content: string;
  };
}

/**
 * Output returned after bundle creation/update
 */
export interface Bundle<P extends BundleProps = BundleProps>
  extends Resource<"esbuild::Bundle">,
    P,
    BundleOutput {}

/**
 * esbuild Bundle Resource
 *
 * Creates and manages bundled JavaScript/TypeScript files using esbuild.
 * Supports various output formats, sourcemaps, and platform targets.
 *
 * @example
 * // Bundle a TypeScript file for Node.js
 * const bundle = await Bundle("handler", {
 *   entryPoint: "src/handler.ts",
 *   outdir: ".alchemy/.out",
 *   format: "esm",
 *   platform: "node",
 *   target: "node18"
 * });
 */
export const Bundle = Resource(
  "esbuild::Bundle",
  {
    alwaysUpdate: true,
  },
  async function <Props extends BundleProps>(
    this: Context<Bundle<any>>,
    _id: string,
    props: Props,
  ): Promise<Bundle<Props>> {
    if (this.phase === "delete") {
      if (this.output?.path) {
        try {
          await fs.rm(this.output.path, { force: true });
        } catch {
          // File doesn't exist or can't be deleted - that's okay for deletion
        }
      }
      return this.destroy();
    }

    const result = await bundle(props);

    // Extract bundle content and source map from esbuild result
    const { content, sourceMap, outputPath } = await extractBundleOutput(result, props);

    // Generate hash for content verification
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    return this({
      ...props,
      path: outputPath as Props extends
        | { outdir: string }
        | { outfile: string }
        ? string
        : undefined,
      hash,
      content,
      sourceMap,
    });
  },
);

/**
 * Extract bundle content and source map from esbuild result
 * Simplified logic that handles both in-memory and disk outputs
 */
async function extractBundleOutput(
  result: esbuild.BuildResult,
  props: BundleProps,
): Promise<{
  content: string;
  sourceMap?: BundleOutput["sourceMap"];
  outputPath?: string;
}> {
  // Handle in-memory output (preferred approach)
  if (result.outputFiles && result.outputFiles.length > 0) {
    let content = "";
    let sourceMap: BundleOutput["sourceMap"] | undefined;
    let outputPath: string | undefined;

    for (const outputFile of result.outputFiles) {
      if (outputFile.path.endsWith(".map")) {
        sourceMap = {
          name: path.basename(outputFile.path),
          content: outputFile.text,
          path: outputFile.path,
        };
      } else {
        content = outputFile.text;
        outputPath = props.outfile || outputFile.path;
      }
    }

    if (!content) {
      throw new Error("No bundle content found in esbuild output");
    }

    return { content, sourceMap, outputPath };
  }

  // Handle disk output (fallback for when write: true)
  if (props.outfile) {
    try {
      const content = await fs.readFile(props.outfile, "utf-8");
      const mapPath = `${props.outfile}.map`;
      let sourceMap: BundleOutput["sourceMap"] | undefined;

      try {
        const mapContent = await fs.readFile(mapPath, "utf-8");
        sourceMap = {
          name: path.basename(mapPath),
          content: mapContent,
          path: mapPath,
        };
      } catch {
        // No source map file - that's okay
      }

      return { content, sourceMap, outputPath: props.outfile };
    } catch (error) {
      throw new Error(`Failed to read bundle from ${props.outfile}: ${error}`);
    }
  }

  throw new Error("No bundle output found - esbuild may have failed");
}

export async function bundle(props: BundleProps) {
  const { entryPoint, ...rest } = props;
  
  // Prefer in-memory processing for consistency with source maps approach
  const shouldWriteToDisk = props.outdir !== undefined || props.outfile !== undefined;

  const options: esbuild.BuildOptions = {
    ...rest,
    write: shouldWriteToDisk,
    entryPoints: [entryPoint],
    outdir: props.outdir,
    outfile: props.outfile,
    bundle: true,
    sourcemap: props.sourcemap === true ? "external" : props.sourcemap,
    metafile: true, // Keep metafile for debugging
  };

  // Clean up conflicting options
  if (props.outfile) {
    options.outdir = undefined; // outfile takes precedence
  }

  if (process.env.DEBUG) {
    console.log("esbuild options:", options);
  }

  const esbuild = await import("esbuild");
  return await esbuild.build(options);
}
