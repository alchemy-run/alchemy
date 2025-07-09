import type esbuild from "esbuild";
import { ESBuildBundleProvider } from "./esbuild.ts";
import { FSBundleProvider } from "./fs.ts";
import { InlineBundleProvider } from "./inline.ts";
import type { WorkerBundleProvider } from "./shared.ts";
import { validateNodeCompat } from "./validate-node-compat.ts";

interface NormalizeWorkerBundleProps {
  script: string | undefined;
  entrypoint: string | undefined;
  noBundle: boolean | undefined;
  format: "cjs" | "esm" | undefined;
  compatibilityDate: string;
  compatibilityFlags: string[];
  rules:
    | {
        globs: string[];
      }[]
    | undefined;
  bundle?: Omit<
    esbuild.BuildOptions,
    "entryPoints" | "format" | "absWorkingDir"
  >;
  cwd: string;
  outdir: string;
  sourceMap: boolean | undefined;
}

export function wrap<T>(fn: () => T): [T, null] | [null, Error] {
  try {
    return [fn(), null];
  } catch (e) {
    return [null, e instanceof Error ? e : new Error(String(e))];
  }
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
  if (props.noBundle) {
    return new FSBundleProvider({
      entrypoint: props.entrypoint,
      format: props.format ?? "esm",
      nodeCompat,
      cwd: props.cwd,
      globs: props.rules?.flatMap((rule) => rule.globs),
      sourcemaps: props.sourceMap !== false,
    });
  }
  return new ESBuildBundleProvider({
    entrypoint: props.entrypoint,
    format: props.format ?? "esm",
    nodeCompat,
    cwd: props.cwd,
    outdir: props.outdir,
    sourcemap: props.sourceMap !== false ? "linked" : undefined,
    ...props.bundle,
  });
}
