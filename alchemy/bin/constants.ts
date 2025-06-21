import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const distPath = path.dirname(__filename);
export const PKG_ROOT = path.join(distPath, "../");

export const dependencyVersionMap = {
  alchemy: "^0.36.0",
} as const;

export type DependencyVersionMap = keyof typeof dependencyVersionMap;
