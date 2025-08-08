import { readFile, writeFile } from "node:fs/promises";
import yaml from "yaml";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const yamlContent = yaml.stringify({
  packages: pkg.workspaces.packages,
  catalog: pkg.workspaces.catalog,
});
await writeFile("pnpm-workspace.yaml", yamlContent, "utf8");
