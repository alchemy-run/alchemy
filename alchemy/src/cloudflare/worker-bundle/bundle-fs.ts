import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeFileType, type WorkerBundle } from "./shared.ts";

export interface FsBundleProps {
  entrypoint: string;
  sourcemaps?: boolean;
  format?: "cjs" | "esm";
  globs?: string[];
}

async function parseOptions(props: FsBundleProps) {
  const globs = props.globs ?? [
    "**/*.js",
    "**/*.mjs",
    "**/*.wasm",
    ...(props.sourcemaps ? ["**/*.js.map"] : []),
  ];
  const root = path.dirname(path.resolve(props.entrypoint));
  const files = new Set<string>();
  await Promise.all(
    globs.map(async (glob) => {
      for await (const file of fs.glob(glob, { cwd: root })) {
        files.add(file);
      }
    }),
  );
  return {
    root,
    files,
    format: props.format ?? "esm",
  };
}

export async function fsBundle(props: FsBundleProps): Promise<WorkerBundle> {
  const { root, files, format } = await parseOptions(props);
  const { bundle } = await readFiles(root, files, format);
  return bundle;
}

// todo: implement
export async function fsWatch(_props: FsBundleProps) {
  return new ReadableStream<WorkerBundle>({});
}

async function readFiles(
  root: string,
  files: Set<string>,
  format: "cjs" | "esm",
): Promise<{
  bundle: WorkerBundle;
  hashes: Record<string, string>;
}> {
  const hashes: Record<string, string> = {};
  const bundle = Object.fromEntries(
    await Promise.all(
      Array.from(files).map(async (file) => {
        const content = await fs.readFile(path.resolve(root, file));
        const hash = crypto.createHash("sha256").update(content).digest("hex");
        hashes[file] = hash;
        return [
          file,
          new File([content], file, {
            type: normalizeFileType(file, format),
          }),
        ];
      }),
    ),
  );
  return {
    bundle,
    hashes,
  };
}
