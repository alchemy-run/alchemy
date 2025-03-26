import * as esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context";
import { Resource } from "../resource";
export interface BundleProps {
  /**
   * Entry point for the bundle
   */
  entryPoint: string;
  /**
   * Output directory for the bundle
   */
  outdir?: string;
  /**
   * Output filename for the bundle
   */
  outfile?: string;
  /**
   * Bundle format (iife, cjs, esm)
   */
  format?: "iife" | "cjs" | "esm";
  /**
   * Target environment (e.g., 'node16', 'es2020')
   */
  target?: string | string[];
  /**
   * Whether to minify the output
   */
  minify?: boolean;
  /**
   * Whether to generate sourcemaps
   */
  sourcemap?: boolean | "inline" | "external" | "both";
  /**
   * External packages to exclude from bundle
   */
  external?: string[];
  /**
   * Platform to target (browser, node, neutral)
   */
  platform?: "browser" | "node" | "neutral";
  /**
   * Additional esbuild options
   */
  options?: Partial<esbuild.BuildOptions>;
}

export interface Bundle extends Resource<"esbuild::Bundle"> {
  /**
   * Path to the bundled file
   */
  path: string;
  /**
   * SHA-256 hash of the bundle contents
   */
  hash: string;
}

export const Bundle = Resource(
  "esbuild::Bundle",
  {
    alwaysUpdate: true,
  },
  async function (
    this: Context<Bundle>,
    id: string,
    props: BundleProps,
  ): Promise<Bundle> {
    // Determine output path
    const outputPath = getOutputPath(props);

    // Ensure output directory exists
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    if (this.phase === "delete") {
      await fs.promises.unlink(outputPath).catch(() => {});
      // Also clean up sourcemap if it exists
      await fs.promises.unlink(outputPath + ".map").catch(() => {});
      return this.destroy();
    }

    const result = await bundle(props);
    // Calculate hash of the output
    const contents = await fs.promises.readFile(outputPath);
    const hash = crypto.createHash("sha256").update(contents).digest("hex");

    // Store metadata in context
    await this.set("metafile", result.metafile);
    await this.set("hash", hash);

    // Return output info
    return this({
      path: outputPath,
      hash,
    });
  },
);

export async function bundle(props: BundleProps) {
  const outputPath = getOutputPath(props);
  // Build the bundle
  return await esbuild.build({
    entryPoints: [props.entryPoint],
    outfile: outputPath,
    bundle: true,
    format: props.format,
    target: props.target,
    minify: props.minify,
    sourcemap: props.sourcemap,
    external: props.external,
    platform: props.platform,
    metafile: true,
    write: true,
    ...props.options,
  });
}

function getOutputPath(props: BundleProps) {
  return (
    props.outfile ||
    path.join(
      props.outdir || "dist",
      path.basename(props.entryPoint, path.extname(props.entryPoint)) + ".js",
    )
  );
}
