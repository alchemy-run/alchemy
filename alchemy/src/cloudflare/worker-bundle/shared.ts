import path from "node:path";
import { getContentType } from "../../util/content-type.ts";

export interface WorkerBundle {
  [name: string]: File;
}

export const normalizeFileType = (file: string, format: "cjs" | "esm") => {
  if (path.extname(file) === ".js" && format === "esm") {
    return "application/javascript+module";
  }
  return getContentType(file);
};
