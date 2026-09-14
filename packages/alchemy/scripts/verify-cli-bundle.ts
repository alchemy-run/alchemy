import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const rendererPackages = new Set([
  "react",
  "react/jsx-runtime",
  "@alchemy.run/sigil",
  "react-reconciler",
  "scheduler",
  "react-devtools-core",
]);
const staticImport = /^\s*import(?:[^;\n]*?\sfrom\s*)?["']([^"']+)["']/gm;

for (const entry of ["alchemy.js", "exec.js"]) {
  const source = readFileSync(`${packageDir}/bin/${entry}`, "utf8");
  const imports = [...source.matchAll(staticImport)].map((match) => match[1]!);
  const externalRendererImports = imports.filter((specifier) =>
    rendererPackages.has(specifier),
  );

  if (externalRendererImports.length > 0) {
    throw new Error(
      `${entry} externalizes renderer dependencies: ${externalRendererImports.join(", ")}`,
    );
  }

  if (!source.includes("ReactSharedInternals")) {
    throw new Error(`${entry} does not contain the private React runtime`);
  }
}

console.log("verified private React renderer in alchemy.js and exec.js");
