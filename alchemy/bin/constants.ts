import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageVersion } from "./services/get-package-version.ts";

const __filename = fileURLToPath(import.meta.url);
const distPath = path.dirname(__filename);
export const PKG_ROOT = path.join(distPath, "../");

export const dependencyVersionMap = {
  alchemy: getPackageVersion(),
} as const;

export type DependencyVersionMap = keyof typeof dependencyVersionMap;
