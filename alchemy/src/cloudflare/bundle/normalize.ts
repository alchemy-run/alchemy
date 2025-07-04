import type esbuild from "esbuild";
import { ESBuildBundleProvider } from "./esbuild.ts";
import { FSBundleProvider } from "./fs.ts";
import { InlineBundleProvider } from "./inline.ts";
import type { WorkerBundleProvider } from "./shared.ts";
import { validateNodeCompat } from "./validate-node-compat.ts";

interface NormalizeWorkerBundleProps {
  script?: string;
  entrypoint?: string;
  noBundle?: boolean;
  format?: "cjs" | "esm";
  compatibilityDate: string;
  compatibilityFlags: string[];
  rules?: {
    globs: string[];
  }[];
  bundle?: Omit<
    esbuild.BuildOptions,
    "entryPoints" | "format" | "absWorkingDir"
  >;
  cwd: string;
  outdir: string;
}

export function normalizeWorkerBundle(
  props: NormalizeWorkerBundleProps,
): WorkerBundleProvider {
  const nodeCompat = validateNodeCompat({
    compatibilityDate: props.compatibilityDate,
    compatibilityFlags: props.compatibilityFlags,
    noBundle: props.noBundle ?? false,
  });
  if (props.script) {
    return new InlineBundleProvider({
      content: props.script,
      format: props.format ?? "esm",
      nodeCompat,
    });
  }
  if (!props.entrypoint) {
    throw new Error(
      "Either `script` or `entrypoint` must be provided for workers",
    );
  }
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    process.exit(0);
  });
  if (props.noBundle) {
    return new FSBundleProvider({
      entrypoint: props.entrypoint,
      format: props.format ?? "esm",
      nodeCompat,
      cwd: props.cwd,
      signal: controller.signal,
    });
  }
  return new ESBuildBundleProvider({
    entrypoint: props.entrypoint,
    format: props.format ?? "esm",
    nodeCompat,
    cwd: props.cwd,
    outdir: props.outdir,
    signal: controller.signal,
    ...props.bundle,
  });
}
