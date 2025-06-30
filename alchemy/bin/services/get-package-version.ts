import fs from "fs-extra";
import path from "node:path";
import { PKG_ROOT } from "../constants.ts";

export const getPackageVersion = () => {
  const packageJsonPath = path.join(PKG_ROOT, "package.json");

  const packageJsonContent = fs.readJSONSync(packageJsonPath);

  return packageJsonContent.version ?? "1.0.0";
};
